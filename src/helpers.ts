import { Signer } from "@ethersproject/abstract-signer";
import {
  Web3Provider,
  TransactionResponse,
  TransactionRequest
} from "@ethersproject/providers";
import {
  Contract,
  ContractFactory,
  PayableOverrides
} from "@ethersproject/contracts";
import { BigNumber } from "@ethersproject/bignumber";
import { Wallet } from "@ethersproject/wallet";
import { keccak256 as solidityKeccak256 } from "@ethersproject/solidity";
import {
  BuidlerRuntimeEnvironment,
  DeployFunction,
  Deployment,
  DeployResult,
  DeploymentsExtension,
  FixtureFunc,
  DeploymentSubmission,
  Artifact,
  DeployOptions,
  EthereumProvider,
  TxOptions,
  CallOptions,
  SimpleTx,
  Receipt,
  Execute,
  Address
} from "@nomiclabs/buidler/types";
import { PartialExtension } from "./types";

function fixProvider(providerGiven: any): any {
  // alow it to be used by ethers without any change
  if (providerGiven.sendAsync === undefined) {
    providerGiven.sendAsync = (
      req: {
        id: number;
        jsonrpc: string;
        method: string;
        params: any[];
      },
      callback: (error: any, result: any) => void
    ) => {
      providerGiven
        .send(req.method, req.params)
        .then((result: any) =>
          callback(null, { result, id: req.id, jsonrpc: req.jsonrpc })
        )
        .catch((error: any) => callback(error, null));
    };
  }
  return providerGiven;
}

function linkLibrary(
  bytecode: string,
  libraryName: string,
  libraryAddress: string
): string {
  const address = libraryAddress.replace("0x", "");
  let encodedLibraryName;
  console.log("dd");
  if (libraryName.startsWith("$") && libraryName.endsWith("$")) {
    encodedLibraryName = libraryName.slice(1, libraryName.length - 1);
  } else {
    encodedLibraryName = solidityKeccak256(["string"], [libraryName]).slice(
      2,
      36
    );
  }
  const pattern = new RegExp(`_+\\$${encodedLibraryName}\\$_+`, "g");
  if (!pattern.exec(bytecode)) {
    throw new Error(
      `Can't link '${libraryName}' (${encodedLibraryName}) in \n----\n ${bytecode}\n----\n`
    );
  }
  return bytecode.replace(pattern, address);
}

function linkRawLibraries(
  bytecode: string,
  libraries: { [libraryName: string]: Address }
): string {
  for (const libName of Object.keys(libraries)) {
    const libAddress = libraries[libName];
    bytecode = linkLibrary(bytecode, libName, libAddress);
  }
  return bytecode;
}

function linkLibraries(
  artifact: {
    bytecode: string;
    linkReferences?: {
      [libraryFileName: string]: {
        [libraryName: string]: Array<{ length: number; start: number }>;
      };
    };
  },
  libraries?: { [libraryName: string]: Address }
) {
  let bytecode = artifact.bytecode;

  if (libraries) {
    if (artifact.linkReferences) {
      for (const [fileName, fileReferences] of Object.entries(
        artifact.linkReferences
      )) {
        for (const [libName, fixups] of Object.entries(fileReferences)) {
          const addr = libraries[libName];
          if (addr === undefined) {
            continue;
          }

          for (const fixup of fixups) {
            bytecode =
              bytecode.substr(0, 2 + fixup.start * 2) +
              addr.substr(2) +
              bytecode.substr(2 + (fixup.start + fixup.length) * 2);
          }
        }
      }
    } else {
      bytecode = linkRawLibraries(bytecode, libraries);
    }
  }

  return bytecode;
}

let provider: Web3Provider;
const availableAccounts: { [name: string]: boolean } = {};
export function addHelpers(
  env: BuidlerRuntimeEnvironment,
  partialExtension: PartialExtension, // TODO
  getArtifact: (name: string) => Promise<Artifact>,
  onPendingTx: (
    txResponse: TransactionResponse,
    name?: string,
    data?: any
  ) => Promise<TransactionResponse>,
  getGasPrice: () => Promise<BigNumber | undefined>,
  log: (...args: any[]) => void
): DeploymentsExtension {
  async function init() {
    if (!provider) {
      provider = new Web3Provider(fixProvider(env.ethereum));
      try {
        const accounts = await provider.send("eth_accounts", []);
        for (const account of accounts) {
          availableAccounts[account.toLowerCase()] = true;
        }
      } catch (e) {}
    }
  }

  async function setupGasPrice(overrides: any) {
    if (!overrides.gasPrice) {
      overrides.gasPrice = await getGasPrice();
    }
  }

  async function overrideGasLimit(
    overrides: any,
    options: {
      estimatedGasLimit?: number | BigNumber | string;
      estimateGasExtra?: number | BigNumber | string;
    },
    estimate: (overrides: any) => Promise<BigNumber>
  ) {
    const estimatedGasLimit = options.estimatedGasLimit
      ? BigNumber.from(options.estimatedGasLimit).toNumber()
      : undefined;
    const estimateGasExtra = options.estimateGasExtra
      ? BigNumber.from(options.estimateGasExtra).toNumber()
      : undefined;
    if (!overrides.gasLimit) {
      overrides.gasLimit = estimatedGasLimit;
      overrides.gasLimit = (await estimate(overrides)).toNumber();
      if (estimateGasExtra) {
        overrides.gasLimit = overrides.gasLimit + estimateGasExtra;
        if (estimatedGasLimit) {
          overrides.gasLimit = Math.min(overrides.gasLimit, estimatedGasLimit);
        }
      }
    }
  }

  async function _deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    const args: any[] = options.args || [];
    await init();
    let from = options.from;
    let ethersSigner: Signer;
    if (!from) {
      throw new Error("no from specified");
    }
    if (from.length >= 64) {
      if (from.length === 64) {
        from = "0x" + from;
      }
      const wallet = new Wallet(from);
      from = wallet.address;
      ethersSigner = wallet;
    } else {
      if (availableAccounts[from.toLowerCase()]) {
        ethersSigner = provider.getSigner(from);
      } else {
        throw new Error(`no signer for ${from}`);
      }
    }
    const artifact = await getArtifact(options.contractName || name);
    const abi = artifact.abi;
    const byteCode = linkLibraries(artifact, options.libraries);
    const factory = new ContractFactory(abi, byteCode, ethersSigner);

    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice,
      value: options.value,
      nonce: options.nonce
    };

    const unsignedTx = factory.getDeployTransaction(...args, overrides);
    await overrideGasLimit(unsignedTx, options, newOverrides =>
      ethersSigner.estimateGas(newOverrides)
    );
    await setupGasPrice(unsignedTx);
    let tx = await ethersSigner.sendTransaction(unsignedTx);

    // let ethersContract;
    // ethersContract = await factory.deploy(...args, overrides);
    // let unsignedTx = {};
    // let tx = ethersContract.deployTransaction;

    if (options.dev_forceMine) {
      try {
        await provider.send("evm_mine", []);
      } catch (e) {}
    }
    const extendedAtifact = artifact as any; // TODO future version of buidler will hopefully have that info
    const preDeployment = {
      abi,
      args,
      linkedData: options.linkedData,
      solidityJson: extendedAtifact.solidityJson,
      solidityMetadata: extendedAtifact.solidityMetadata,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
      userdoc: extendedAtifact.userdoc,
      devdoc: extendedAtifact.devdoc,
      methodIdentifiers: extendedAtifact.methodIdentifiers
    };
    tx = await onPendingTx(tx, name, preDeployment);
    const receipt = await tx.wait();
    const address = receipt.contractAddress;
    const deployment = {
      ...preDeployment,
      receipt
    };
    await env.deployments.save(name, deployment);
    return {
      ...deployment,
      address,
      newlyDeployed: true
    };
  }

  function getDeployment(name: string): Promise<Deployment> {
    return env.deployments.get(name);
  }

  async function fetchIfDifferent(
    name: string,
    options: DeployOptions
  ): Promise<boolean> {
    const argArray = options.args ? [...options.args] : [];
    await init();
    const fieldsToCompareArray =
      typeof options.fieldsToCompare === "string"
        ? [options.fieldsToCompare]
        : options.fieldsToCompare || [];
    const deployment = await env.deployments.getOrNull(name);
    if (deployment) {
      const transaction = await provider.getTransaction(
        deployment.receipt.transactionHash
      );
      if (transaction) {
        const artifact = await getArtifact(options.contractName || name);
        const abi = artifact.abi;
        const byteCode = linkLibraries(artifact, options.libraries);
        const factory = new ContractFactory(
          abi,
          byteCode,
          provider.getSigner(options.from)
        );

        const compareOnData = fieldsToCompareArray.indexOf("data") !== -1;

        let data;
        if (compareOnData) {
          const deployStruct = factory.getDeployTransaction(...argArray);
          data = deployStruct.data;
        }
        const newTransaction = {
          data: compareOnData ? data : undefined,
          gasLimit: options.gasLimit,
          gasPrice: options.gasPrice,
          value: options.value,
          from: options.from
        };

        transaction.data = transaction.data;
        for (const field of fieldsToCompareArray) {
          if (typeof (newTransaction as any)[field] === "undefined") {
            throw new Error(
              "field " +
                field +
                " not specified in new transaction, cant compare"
            );
          }
          if ((transaction as any)[field] !== (newTransaction as any)[field]) {
            return true;
          }
        }
        return false;
      }
    }
    return true;
  }

  async function deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    await init();
    const argsArray = options.args ? [...options.args] : [];
    options = { ...options, args: argsArray };
    if (options.fieldsToCompare === undefined) {
      options.fieldsToCompare = ["data"];
    }
    let result: DeployResult;
    if (options.fieldsToCompare) {
      const differences = await fetchIfDifferent(name, options);
      if (differences) {
        result = await _deploy(name, options);
      } else {
        result = ((await getDeployment(name)) as unknown) as DeployResult;
      }
    } else {
      result = await _deploy(name, options);
    }
    if (options.log) {
      if (result.newlyDeployed) {
        log(
          `"${name}" deployed at ${result.address} with ${result.receipt.gasUsed} gas`
        );
      } else {
        log(`reusing "${name}" at ${result.address}`);
      }
    }
    return result;
  }

  async function batchExecute(
    txs: Execute[],
    batchOptions: { dev_forceMine: boolean }
  ): Promise<Array<Receipt | null>> {
    await init();
    const promises = [];
    const currentNonces: {
      [address: string]: number | string | BigNumber;
    } = {};
    const savedTxs: Execute[] = [];
    for (const tx of txs) {
      const newTx = { ...tx };
      if (tx.args) {
        newTx.args = [...tx.args];
      } else {
        newTx.args = [];
      }
      savedTxs.push();
    }
    for (const tx of savedTxs) {
      let from = tx.from;
      let ethersSigner;
      if (from.length >= 64) {
        if (from.length === 64) {
          from = "0x" + from;
        }
        ethersSigner = new Wallet(from);
        from = ethersSigner.address;
      } else {
        if (availableAccounts[from.toLowerCase()]) {
          try {
            ethersSigner = provider.getSigner(from);
          } catch (e) {}
        }
      }
      const nonce =
        tx.nonce ||
        currentNonces[from] ||
        (await provider.getTransactionCount(from));
      tx.nonce = nonce;
      currentNonces[from] = nonce + 1;
      const args = tx.args || [];
      promises.push(execute(tx.name, tx, tx.methodName, ...args));
    }
    if (batchOptions.dev_forceMine) {
      try {
        await provider.send("evm_mine", []);
      } catch (e) {}
    }
    return Promise.all(promises);
  }

  async function rawTx(tx: SimpleTx): Promise<Receipt | null> {
    await init();
    let from = tx.from;
    let ethersSigner;
    if (from.length >= 64) {
      if (from.length === 64) {
        from = "0x" + from;
      }
      ethersSigner = new Wallet(from);
      from = ethersSigner.address;
    } else {
      if (availableAccounts[from.toLowerCase()]) {
        try {
          ethersSigner = provider.getSigner(from);
        } catch (e) {}
      }
    }

    if (!ethersSigner) {
      console.error("no signer for " + from);
      log("Please execute the following as " + from);
      log(
        JSON.stringify(
          {
            to: tx.to,
            data: tx.data
          },
          null,
          "  "
        )
      );
      if (tx.skipUnknownSigner) {
        return null;
      }
      throw new Error("ABORT, ACTION REQUIRED, see above");
    } else {
      const transactionData = {
        to: tx.to,
        gasLimit: tx.gasLimit,
        gasPrice: tx.gasPrice ? BigNumber.from(tx.gasPrice) : undefined, // TODO cinfig
        value: tx.value ? BigNumber.from(tx.value) : undefined,
        nonce: tx.nonce,
        data: tx.data
      };
      let pendingTx = await ethersSigner.sendTransaction(transactionData);
      pendingTx = await onPendingTx(pendingTx);
      if (tx.dev_forceMine) {
        try {
          await provider.send("evm_mine", []);
        } catch (e) {}
      }
      return pendingTx.wait();
    }
  }

  async function execute(
    name: string,
    options: TxOptions,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt | null> {
    await init();
    let from = options.from;
    let ethersSigner;
    if (from.length >= 64) {
      if (from.length === 64) {
        from = "0x" + from;
      }
      ethersSigner = new Wallet(from);
      from = ethersSigner.address;
    } else {
      if (availableAccounts[from.toLowerCase()]) {
        try {
          ethersSigner = provider.getSigner(from);
        } catch (e) {}
      }
    }

    let tx;
    let unsignedTx;
    const deployment = await env.deployments.get(name);
    const abi = deployment.abi;
    const overrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce
    };

    const ethersContract = new Contract(
      deployment.address,
      abi,
      (ethersSigner as Signer) || provider
    );
    if (!ethersContract.functions[methodName]) {
      throw new Error(
        `No method named "${methodName}" on contract deployed as "${name}"`
      );
    }
    if (!ethersSigner) {
      // ethers.js : would be nice to be able to estimate even if not access to signer (see below)
      console.error("no signer for " + from);
      log("Please execute the following as " + from);
      const ethersArgs = args ? args.concat([overrides]) : [overrides];
      const { data } = await ethersContract.populateTransaction[methodName](
        ...ethersArgs
      );
      log(
        JSON.stringify(
          {
            to: deployment.address,
            data
          },
          null,
          "  "
        )
      );
      log("if you have an interface use the following");
      log(
        JSON.stringify(
          {
            to: deployment.address,
            method: methodName,
            args
          },
          null,
          "  "
        )
      );
      if (options.skipUnknownSigner) {
        return null;
      }
      throw new Error("ABORT, ACTION REQUIRED, see above");
    } else {
      await overrideGasLimit(overrides, options, newOverrides => {
        const ethersArgsWithGasLimit = args
          ? args.concat([newOverrides])
          : [newOverrides];
        return ethersContract.estimateGas[methodName](
          ...ethersArgsWithGasLimit
        );
      });
      await setupGasPrice(overrides);
      const ethersArgs = args ? args.concat([overrides]) : [overrides];
      const { data, to } = await ethersContract.populateTransaction[methodName](
        ...ethersArgs
      );

      unsignedTx = { ...overrides, data, to };
      tx = await ethersSigner.sendTransaction(unsignedTx);
    }

    tx = await onPendingTx(tx);

    if (options.dev_forceMine) {
      try {
        await provider.send("evm_mine", []);
      } catch (e) {}
    }
    return tx.wait();
  }

  // TODO ?
  // async function rawCall(to: string, data: string) {
  //   // TODO call it eth_call?
  //   await init();
  //   return provider.send("eth_call", [
  //     {
  //       to,
  //       data
  //     },
  //     "latest"
  //   ]); // TODO overrides
  // }

  async function read(
    name: string,
    options: CallOptions | string,
    methodName?: string | any,
    ...args: unknown[]
  ) {
    await init();
    if (typeof options === "string") {
      if (typeof methodName !== "undefined") {
        args.unshift(methodName);
      }
      methodName = options;
      options = {};
    }
    if (typeof args === "undefined") {
      args = [];
    }
    let from = options.from;
    let ethersSigner;
    if (from && from.length >= 64) {
      if (from.length === 64) {
        from = "0x" + from;
      }
      ethersSigner = new Wallet(from);
      from = ethersSigner.address;
    }
    if (!ethersSigner) {
      ethersSigner = provider; // TODO rename ethersSigner
    }
    const deployment = await env.deployments.get(name);
    if (!deployment) {
      throw new Error(`no contract named "${name}"`);
    }
    const abi = deployment.abi;
    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce
    };
    const ethersContract = new Contract(
      deployment.address,
      abi,
      ethersSigner as Signer
    );
    // populate function
    // if (options.outputTx) {
    //   const method = ethersContract.populateTransaction[methodName];
    //   if (!method) {
    //     throw new Error(
    //       `no method named "${methodName}" on contract "${name}"`
    //     );
    //   }
    //   if (args.length > 0) {
    //     return method(...args, overrides);
    //   } else {
    //     return method(overrides);
    //   }
    // }
    const method = ethersContract.callStatic[methodName];
    if (!method) {
      throw new Error(`no method named "${methodName}" on contract "${name}"`);
    }
    if (args.length > 0) {
      return method(...args, overrides);
    } else {
      return method(overrides);
    }
  }

  const extension: DeploymentsExtension = {
    ...partialExtension,
    fetchIfDifferent,
    deploy,
    execute,
    batchExecute,
    rawTx,
    read
  };

  // ////////// Backward compatible for transition: //////////////////
  (extension as any).call = (
    options: any,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<any> => {
    if (typeof options === "string") {
      args = args || [];
      if (methodName !== undefined) {
        args.unshift(methodName);
      }
      methodName = name;
      name = options;
      options = {};
    }
    return read(name, options, methodName, ...args);
  };

  (extension as any).sendTxAndWait = (
    options: TxOptions,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt | null> => {
    return execute(name, options, methodName, ...args);
  };

  (extension as any).deployIfDifferent = (
    fieldsToCompare: string | string[],
    name: string,
    options: DeployOptions,
    contractName: string,
    ...args: any[]
  ): Promise<DeployResult> => {
    options.fieldsToCompare = fieldsToCompare;
    options.contractName = contractName;
    options.args = args;
    return deploy(name, options);
  };
  // ////////////////////////////////////////////////////////////////////

  return extension;
}

function pause(duration: number): Promise<void> {
  return new Promise(res => setTimeout(res, duration * 1000));
}

export async function waitForTx(
  ethereum: EthereumProvider,
  txHash: string,
  isContract: boolean
) {
  let receipt;
  while (true) {
    try {
      receipt = await ethereum.send("eth_getTransactionReceipt", [txHash]);
    } catch (e) {}
    if (receipt && receipt.blockNumber) {
      if (isContract) {
        if (!receipt.contractAddress) {
          throw new Error("contract not deployed");
        } else {
          return receipt;
        }
      } else {
        return receipt;
      }
    }
    await pause(2);
  }
}
