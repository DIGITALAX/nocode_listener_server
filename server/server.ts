import express, { NextFunction, Request, Response } from "express";
import * as LitJsSdk from "@lit-protocol/lit-node-client";
import { joinSignature } from "@ethersproject/bytes";
import { serialize } from "@ethersproject/transactions";
import cors from "cors";
import {
  Circuit,
  IConditionalLogic,
  Action,
  Condition,
  IExecutionConstraints,
  ILogEntry,
  LogCategory,
  WebhookCondition,
  ContractCondition,
  LitUnsignedTransaction,
} from "lit-listener-sdk";
import { v4 as uuidv4 } from "uuid";
import {
  CONTRACT_INTERFACE,
  IPFS_AUTH,
  LISTENER_DB_ADDRESS,
  PKP_PUBLIC_KEY,
} from "./constants";
import { LitAuthSig } from "./types";
import WebSocket from "ws";
import http from "http";
import { create } from "ipfs-http-client";
import BluebirdPromise from "bluebird";
import { ethers } from "ethers";
import { ExecuteJsProps, ExecuteJsResponse } from "@lit-protocol/types";

const activeCircuits = new Map();
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const port = 3001;
let clientSocket: WebSocket | null = null;
let authSig: LitAuthSig;
const litClient = new LitJsSdk.LitNodeClient({
  litNetwork: "serrano",
  debug: true,
});
// Create an IPFS client instance
const client = create({
  url: "https://ipfs.infura.io:5001/api/v0",
  headers: {
    authorization: IPFS_AUTH,
  },
});
const providerDB = new ethers.providers.JsonRpcProvider(
  `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_KEY}`,
  137
);

app.use(express.json());
app.use(cors());

// Auth validation
const apiKeyValidationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

app.use(apiKeyValidationMiddleware);

wss.on("connection", (socket) => {
  console.log("WebSocket connection established");

  clientSocket = socket;

  socket.on("message", (message) => {
    console.log("Received message from client:", message);
  });

  socket.on("close", (event) => {
    console.log("WebSocket connection closed with code", "and reason", event);
    console.log("WebSocket connection closed");
    clientSocket = null;
  });
});

app.post("/instantiate", async (req: Request, res: Response) => {
  let id: string | undefined;
  try {
    const {
      provider,
      executionConstraints,
      contractConditions,
      contractActions,
      conditionalLogic,
    } = req.body;

    // instantiate the new circuit
    const newCircuit = new Circuit(provider);

    const newExecutionConstraints = {
      ...executionConstraints,
      startDate: new Date(executionConstraints.startDate as any),
      endDate: new Date(executionConstraints.endDate as any),
    };

    const newConditions = createConditions(contractConditions);

    // Create new circuit with ListenerDB
    const results = await addCircuitLogic(
      newCircuit,
      newConditions,
      contractActions,
      conditionalLogic,
      newExecutionConstraints
    );
    id = results?.id;

    // Add the circuit to the activeCircuits map
    activeCircuits.set(id, {
      newCircuit,
      newConditions,
      contractActions,
      conditionalLogic,
      newExecutionConstraints,
      unsignedTransactionData: results?.unsignedTransactionDataObject,
    });

    // Send the IPFS CID back
    if (clientSocket && results?.ipfsCID) {
      clientSocket.send(
        JSON.stringify({
          ipfs: results?.ipfsCID,
          id,
        })
      );
    }

    return res.status(200).json({
      message: `Circuit Successfully Instantiated with id ${id}`,
      id,
    });
  } catch (err: any) {
    // Delete on error if it exists
    if (activeCircuits.has(id)) {
      activeCircuits.delete(id);
    }
    return res.json({ message: `Error instantiating Circuit: ${err.message}` });
  }
});

app.post("/start", async (req: Request, res: Response) => {
  try {
    const {
      id,
      instantiatorAddress,
      authSignature,
      tokenId,
      publicKey,
      address,
    } = req.body;

    // Save the circuit configuration to the database
    await saveCircuitToSubgraph(
      id,
      tokenId,
      publicKey,
      address,
      instantiatorAddress,
      {
        contractConditions: activeCircuits.get(id).contractConditions,
        contractActions: activeCircuits.get(id).contractActions,
        conditionalLogic: activeCircuits.get(id).conditionalLogic,
        executionConstraints: activeCircuits.get(id).executionConstraints,
      }
    );

    // Listen in on all logs
    activeCircuits.get(id).newCircuit.on("log", (logEntry: ILogEntry) => {
      saveLogToSubgraph(
        logEntry,
        id,
        instantiatorAddress,
        activeCircuits.get(id).newCircuit
      );
    });

    let startCircuitPromise = activeCircuits.get(id).newCircuit.start({
      publicKey: publicKey,
      ipfsCID: undefined,
      authSig: authSignature,
      broadcast: true,
    });

    // Convert the startCircuitPromise to a Bluebird promise
    startCircuitPromise = BluebirdPromise.resolve(startCircuitPromise);

    startCircuitPromise
      .then(() => {
        // Send Confirmation
        if (clientSocket) {
          clientSocket.send(
            JSON.stringify({
              status: "success",
              message: `Circuit with id ${id} has started successfully.`,
            })
          );
        }
      })
      .catch((error: any) => {
        // Send Confirmation
        if (clientSocket) {
          clientSocket.send(
            JSON.stringify({
              status: "error",
              message: error.message,
            })
          );
        }
      });

    await BluebirdPromise.race([
      startCircuitPromise,
      new BluebirdPromise((resolve) => setTimeout(resolve, 20000)),
    ]);

    if (startCircuitPromise.isFulfilled()) {
      return res.status(200).json({
        message: `Circuit Successfully resolved with id ${id}`,
      });
    } else if (startCircuitPromise.isRejected()) {
      return res.status(500).json({
        message: `Error Starting Circuit ${id}: ${
          startCircuitPromise.reason().message
        }`,
      });
    } else {
      return res.status(202).json({
        message: `Circuit ${id} has started running.`,
      });
    }
  } catch (err: any) {
    return res.json({ message: `Error Starting Circuit: ${err.message}` });
  }
});

app.post("/interrupt", async (req: Request, res: Response) => {
  try {
    const { id, instantiatorAddress } = req.body;

    activeCircuits.delete(id);
    const results = await interruptCircuitRunning(id, instantiatorAddress);

    return res.status(200).json({
      message: `Circuit Successfully Interrupted with id ${id}`,
      results: JSON.stringify(results),
    });
  } catch (err: any) {
    return res.json({ message: `Error interrupting Circuit: ${err.message}` });
  }
});

app.post("/connect", async (req: Request, res: Response) => {
  try {
    const { globalAuthSignature } = req.body;
    await connectLitClient();

    // set auth signature
    authSig = globalAuthSignature;

    return res.status(200).json({ message: `Lit Client Connected` });
  } catch (err: any) {
    return res.json({
      message: `Error connecting to Lit Client: ${err.message}`,
    });
  }
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const addCircuitLogic = async (
  newCircuit: Circuit,
  contractConditions: Condition[],
  contractActions: Action[],
  conditionalLogic: IConditionalLogic,
  executionConstraints: IExecutionConstraints
): Promise<
  | {
      id: string;
      ipfsCID: string | undefined;
      unsignedTransactionDataObject: {
        [key: string]: LitUnsignedTransaction;
      };
    }
  | undefined
> => {
  try {
    const id = uuidv4();
    newCircuit.setConditions(contractConditions);
    const { unsignedTransactionDataObject, litActionCode } =
      await newCircuit.setActions(contractActions);
    newCircuit.setConditionalLogic(conditionalLogic);
    newCircuit.executionConstraints(executionConstraints);
    const ipfsCID = await ipfsUpload(litActionCode);

    return { id, ipfsCID, unsignedTransactionDataObject };
  } catch (err: any) {
    console.error(err.message);
  }
};

const saveCircuitToSubgraph = async (
  id: string,
  tokenId: string,
  pkpPublicKey: string,
  pkpAddress: string,
  instantiatorAddress: string,
  information: {
    contractConditions: Condition[];
    contractActions: Action[];
    conditionalLogic: IConditionalLogic;
    executionConstraints: IExecutionConstraints;
  }
): Promise<void> => {
  try {
    const circuitInformation = {
      tokenId,
      pkpPublicKey,
      pkpAddress,
      instantiatorAddress,
      information,
    };
    const unsignedTransactionData = generateUnsignedData("addCircuitOnChain", [
      id,
      circuitInformation,
      instantiatorAddress,
    ]);
    await executeJS(unsignedTransactionData);
  } catch (err: any) {
    console.log("subgraph error");
    console.error(err.message);
  }
};

const saveLogToSubgraph = async (
  logEntry: ILogEntry,
  id: string,
  instantiatorAddress: string,
  newCircuit: Circuit
) => {
  try {
    if (
      logEntry.category === LogCategory.ERROR ||
      (logEntry.category === LogCategory.CONDITION &&
        logEntry.message.includes(
          "Execution Condition Not Met to Continue Circuit."
        ))
    ) {
      const unsignedTransactionData = generateUnsignedData("addLogToCircuit", [
        instantiatorAddress,
        id,
        [JSON.stringify(logEntry)],
      ]);
      await executeJS(unsignedTransactionData);

      if (
        logEntry.category === LogCategory.CONDITION &&
        logEntry.message.includes(
          "Execution Condition Not Met to Continue Circuit."
        )
      ) {
        const unsignedTransactionDataComplete = generateUnsignedData(
          "completeCircuit",
          [instantiatorAddress, id]
        );
        await executeJS(unsignedTransactionDataComplete);

        // Delete from active circuits on complete
        activeCircuits.delete(id);
      }
    } else if (newCircuit.getLogs().length % 10 === 0) {
      const unsignedTransactionData = generateUnsignedData("addLogToCircuit", [
        instantiatorAddress,
        id,
        newCircuit
          .getLogs()
          .slice(-10)
          .map((log) => JSON.stringify(log)),
      ]);
      await executeJS(unsignedTransactionData);
    }
  } catch (err: any) {
    console.error(err.message);
  }
};

const interruptCircuitRunning = async (
  id: string,
  instantiatorAddress: string
) => {
  try {
    const unsignedTransactionData = generateUnsignedData("interruptCircuit", [
      id,
      instantiatorAddress,
    ]);

    const results = await executeJS(unsignedTransactionData);

    return { id, response: results.response };
  } catch (err: any) {
    console.error(err.message);
  }
};

const executeJS = async (unsignedTransactionData: {
  to: `0x${string}`;
  nonce: number;
  chainId: number;
  gasLimit: string;
  gasPrice: undefined;
  maxFeePerGas: undefined;
  maxPriorityFeePerGas: undefined;
  from: string;
  data: string;
  value: number;
  type: number;
}): Promise<any> => {
  try {
    const results = await litClient.executeJs({
      ipfsId: "QmbBh8Wu12DVATwQGsLHqx5fT6eSYFQnXys3eYuVEEqkRV",
      code: undefined,
      authSig,
      jsParams: {
        publicKey: PKP_PUBLIC_KEY,
        unsignedTransactionData,
      },
    });
    console.log({ sigs: results.signatures, debug: results.debug });

    // Broadcast the signed transaction
    await broadCastToDB(results, unsignedTransactionData);

    return { results };
  } catch (err: any) {
    console.error(err.message);
  }
};

const connectLitClient = async () => {
  try {
    await litClient.connect();
  } catch (err: any) {
    console.error(err.message);
  }
};

const generateUnsignedData = (functionName: string, args: any[]) => {
  return {
    to: LISTENER_DB_ADDRESS,
    nonce: 0,
    chainId: 137,
    gasLimit: "50000",
    gasPrice: undefined,
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
    from: "{{publicKey}}",
    data: CONTRACT_INTERFACE.encodeFunctionData(functionName, args),
    value: 0,
    type: 2,
  };
};

const ipfsUpload = async (
  litActionCode: string
): Promise<string | undefined> => {
  try {
    const added = await client.add(litActionCode);
    return added.path;
  } catch (err: any) {
    console.error(err.message);
  }
};

const createConditions = (conditions: Condition[]) => {
  let newConditions: Condition[] = [];

  for (let i = 0; i < conditions?.length; i++) {
    if ((conditions[i] as WebhookCondition)?.baseUrl) {
      const webhookCondition = new WebhookCondition(
        (conditions[i] as WebhookCondition).baseUrl,
        (conditions[i] as WebhookCondition).endpoint,
        (conditions[i] as WebhookCondition).responsePath,
        (conditions[i] as WebhookCondition).expectedValue,
        (conditions[i] as WebhookCondition).matchOperator,
        (conditions[i] as WebhookCondition).apiKey,
        (conditions[i] as WebhookCondition).onMatched,
        (conditions[i] as WebhookCondition).onUnMatched,
        (conditions[i] as WebhookCondition).onError
      );
      newConditions.push(webhookCondition);
    } else {
      const webhookCondition = new ContractCondition(
        (conditions[i] as ContractCondition).contractAddress,
        (conditions[i] as ContractCondition).abi,
        (conditions[i] as ContractCondition).chainId,
        (conditions[i] as ContractCondition).providerURL,
        (conditions[i] as ContractCondition).eventName,
        (conditions[i] as ContractCondition).eventArgName,
        (conditions[i] as ContractCondition).expectedValue,
        (conditions[i] as ContractCondition).matchOperator,
        (conditions[i] as ContractCondition).onMatched,
        (conditions[i] as ContractCondition).onUnMatched,
        (conditions[i] as ContractCondition).onError
      );
      newConditions.push(webhookCondition);
    }
  }
  return newConditions;
};

const broadCastToDB = async (
  results: ExecuteJsResponse,
  unsignedTransactionData: {
    to: `0x${string}`;
    nonce: number;
    chainId: number;
    gasLimit: string;
    gasPrice: undefined;
    maxFeePerGas: undefined;
    maxPriorityFeePerGas: undefined;
    from: string;
    data: string;
    value: number;
    type: number;
  }
): Promise<void> => {
  try {
    const signature = results.signatures[0];
    const sig: {
      r: string;
      s: string;
      recid: number;
      signature: string;
      publicKey: string;
      dataSigned: string;
    } = signature as {
      r: string;
      s: string;
      recid: number;
      signature: string;
      publicKey: string;
      dataSigned: string;
    };

    const encodedSignature = joinSignature({
      r: "0x" + sig.r,
      s: "0x" + sig.s,
      recoveryParam: sig.recid,
    });

    const serialized = serialize(unsignedTransactionData, encodedSignature);
    const transactionHash = await providerDB.sendTransaction(serialized);
    await transactionHash.wait();
  } catch (err: any) {
    console.error(err.message);
  }
};
