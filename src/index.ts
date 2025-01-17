import {
  BuidlerNetworkConfig,
  EthereumProvider,
  ResolvedBuidlerConfig,
  BuidlerRuntimeEnvironment
} from "@nomiclabs/buidler/types";
import { createProvider } from "@nomiclabs/buidler/internal/core/providers/construction";
import { lazyObject } from "@nomiclabs/buidler/internal/util/lazy";
import {
  extendEnvironment,
  task,
  internalTask
} from "@nomiclabs/buidler/config";
import { BuidlerError } from "@nomiclabs/buidler/internal//core/errors";
import {
  JsonRpcServer,
  JsonRpcServerConfig
} from "@nomiclabs/buidler/internal/buidler-evm/jsonrpc/server";
import { BUIDLEREVM_NETWORK_NAME } from "@nomiclabs/buidler/internal/constants";
import * as types from "@nomiclabs/buidler/internal/core/params/argumentTypes";
import { ERRORS } from "@nomiclabs/buidler/internal/core/errors-list";
import chalk from "chalk";
// import { TASK_NODE } from "./task-names";
const TASK_NODE = "node";
import debug from "debug";
const log = debug("buidler:wighawag:buidler-deploy");

import { DeploymentsManager } from "./DeploymentsManager";

function isBuidlerEVM(bre: BuidlerRuntimeEnvironment): boolean {
  const { network, buidlerArguments, config } = bre;
  return !(
    network.name !== BUIDLEREVM_NETWORK_NAME &&
    // We normally set the default network as buidlerArguments.network,
    // so this check isn't enough, and we add the next one. This has the
    // effect of `--network <defaultNetwork>` being a false negative, but
    // not a big deal.
    buidlerArguments.network !== undefined &&
    buidlerArguments.network !== config.defaultNetwork
  );
}

export default function() {
  log("start...");
  let deploymentsManager: DeploymentsManager;
  extendEnvironment(env => {
    let live = true;
    if (env.network.name === "localhost" || env.network.name === "buidlerevm") {
      // the 2 default network are not live network
      live = false;
    }
    if (env.network.config.live !== undefined) {
      live = env.network.config.live;
    }
    env.network.live = live;

    if (env.network.config.saveDeployments === undefined) {
      env.network.saveDeployments = true; // always save (unless fixture or test? env.network.live;
    } else {
      env.network.saveDeployments = env.network.config.saveDeployments;
    }

    if (deploymentsManager === undefined || env.deployments === undefined) {
      deploymentsManager = new DeploymentsManager(env);
      env.deployments = deploymentsManager.deploymentsExtension;
      env.getNamedAccounts = deploymentsManager.getNamedAccounts.bind(
        deploymentsManager
      );
    }
    log("ready");
  });

  internalTask("deploy:run", "deploy ")
    .addOptionalParam("export", "export current network deployments")
    .addOptionalParam("exportAll", "export all deployments into one file")
    .addOptionalParam("tags", "dependencies to run")
    .addOptionalParam(
      "write",
      "whether to write deployments to file",
      true,
      types.boolean
    )
    .addOptionalParam(
      "reset",
      "whether to delete deployments files first",
      false,
      types.boolean
    )
    .addOptionalParam("log", "whether to output log", false, types.boolean)
    .addOptionalParam(
      "pendingtx",
      "whether to save pending tx",
      false,
      types.boolean
    )
    .addOptionalParam(
      "gasprice",
      "gas price to use for transactions",
      undefined,
      types.string
    )
    .setAction(async (args, bre) => {
      await bre.run("compile");
      return deploymentsManager.runDeploy(args.tags, {
        log: args.log,
        resetMemory: false, // this is memory reset, TODO rename it
        deletePreviousDeployments: args.reset,
        writeDeploymentsToFiles: args.write,
        export: args.export,
        exportAll: args.exportAll,
        savePendingTx: args.pendingtx,
        gasPrice: args.gasprice
      });
    });

  task("deploy", "Deploy contracts")
    .addOptionalParam("export", "export current network deployments")
    .addOptionalParam("exportAll", "export all deployments into one file")
    .addOptionalParam("tags", "dependencies to run")
    .addOptionalParam(
      "write",
      "whether to write deployments to file",
      undefined,
      types.boolean
    )
    .addOptionalParam(
      "reset",
      "whether to delete deployments files first",
      false,
      types.boolean
    )
    .addOptionalParam("log", "whether to output log", true, types.boolean)
    .addOptionalParam(
      "gasprice",
      "gas price to use for transactions",
      undefined,
      types.string
    )
    .setAction(async (args, bre) => {
      if (args.write === undefined) {
        args.write = !isBuidlerEVM(bre);
      }
      args.pendingtx = !isBuidlerEVM(bre);
      await bre.run("deploy:run", args);
    });

  // TODO
  // task(
  //   "export",
  //   "export contract deployment of the specified network into one file"
  // )
  //   .addOptionalParam("all", "export all deployments into one file")
  //   .setAction(async (args, bre) => {

  //   });

  function _createBuidlerEVMProvider(
    config: ResolvedBuidlerConfig
  ): EthereumProvider {
    log("Creating BuidlerEVM Provider");

    const networkName = BUIDLEREVM_NETWORK_NAME;
    const networkConfig = config.networks[networkName] as BuidlerNetworkConfig;

    return lazyObject(() => {
      log(`Creating buidlerevm provider for JSON-RPC sever`);
      return createProvider(
        networkName,
        { loggingEnabled: true, ...networkConfig },
        config.solc.version,
        config.paths
      );
    });
  }

  task(TASK_NODE, "Starts a JSON-RPC server on top of Buidler EVM")
    .addOptionalParam("export", "export current network deployments")
    .addOptionalParam("exportAll", "export all deployments into one file")
    .addOptionalParam("tags", "dependencies to run")
    .addOptionalParam(
      "write",
      "whether to write deployments to file",
      true,
      types.boolean
    )
    .addOptionalParam(
      "reset",
      "whether to delete deployments files first",
      true,
      types.boolean
    )
    .addOptionalParam("log", "whether to output log", true, types.boolean)
    .setAction(async (args, bre, runSuper) => {
      args.pendingtx = !isBuidlerEVM(bre);
      await bre.run("deploy:run", args);
      // TODO return runSuper(args); and remove the rest (used for now to remove login privateKeys)
      if (!isBuidlerEVM(bre)) {
        throw new BuidlerError(
          ERRORS.BUILTIN_TASKS.JSONRPC_UNSUPPORTED_NETWORK
        );
      }
      const { hostname, port } = args;
      try {
        const serverConfig: JsonRpcServerConfig = {
          hostname,
          port,
          provider: _createBuidlerEVMProvider(bre.config)
        };

        const server = new JsonRpcServer(serverConfig);

        const { port: actualPort, address } = await server.listen();

        console.log(
          chalk.green(
            `Started HTTP and WebSocket JSON-RPC server at http://${address}:${actualPort}/`
          )
        );

        await server.waitUntilClosed();
      } catch (error) {
        if (BuidlerError.isBuidlerError(error)) {
          throw error;
        }

        throw new BuidlerError(
          ERRORS.BUILTIN_TASKS.JSONRPC_SERVER_ERROR,
          {
            error: error.message
          },
          error
        );
      }
    });
}
