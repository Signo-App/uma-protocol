import ethers from "ethers";
import type { providers, ContractTransaction } from "ethers";
import assert from "assert";
import { predeploys, getContractInterface } from "@eth-optimism/contracts";
import { TransactionReceipt } from "@ethersproject/abstract-provider";
import {
  ERC20Ethers__factory,
  L1StandardBridgeEthers__factory,
  L2StandardBridgeEthers__factory,
  L2StandardERC20Ethers__factory,
} from "@uma/contracts-node";
// import { Watcher } from "@eth-optimism/core-utils";

import type { SignerOrProvider } from "../..";
import { BigNumberish } from "../../utils";

const L2_STANDARD_BRIDGE_ADDRESS = "0x4200000000000000000000000000000000000010";

/**
 * Create a transaction to deposit ERC20 tokens to Optimism
 * @param l1Provider The L1 wallet provider (signer)
 * @param l2Provider The L2 wallet provider (signer). This is the same address as L1, but with a different RPC provider
 * @param l1Erc20Address The L1 token address
 * @param l2Erc20Address The L2 token address
 * @param amount The amount to be deposited in wei
 * @returns The submitted transaction
 */
export async function depositERC20(
  l1Provider: SignerOrProvider,
  l2Provider: SignerOrProvider,
  l1Erc20Address: string,
  l2Erc20Address: string,
  amount: BigNumberish
): Promise<ContractTransaction> {
  const L2StandardBridge = L2StandardBridgeEthers__factory.connect(L2_STANDARD_BRIDGE_ADDRESS, l2Provider);
  const L1StandardBridgeAddress = await L2StandardBridge.l1TokenBridge();
  const L1StandardBridge = L1StandardBridgeEthers__factory.connect(L1StandardBridgeAddress, l1Provider);
  const L1_ERC20 = ERC20Ethers__factory.connect(l1Erc20Address, l1Provider);
  const L2_ERC20 = L2StandardERC20Ethers__factory.connect(l2Erc20Address, l2Provider);

  assert((await L2_ERC20.l1Token()) === L1_ERC20.address, "L2 token does not correspond to L1 token");
  return L1StandardBridge.depositERC20(L1_ERC20.address, L2_ERC20.address, amount, 2000000, "0x");
}

export async function depositEth(
  l1Provider: SignerOrProvider,
  l2Provider: SignerOrProvider,
  l1Erc20Address: string,
  l2Erc20Address: string,
  amount: BigNumberish
): Promise<ContractTransaction> {
  const L2StandardBridge = L2StandardBridgeEthers__factory.connect(L2_STANDARD_BRIDGE_ADDRESS, l2Provider);
  const L1StandardBridgeAddress = await L2StandardBridge.l1TokenBridge();
  const L1StandardBridge = L1StandardBridgeEthers__factory.connect(L1StandardBridgeAddress, l1Provider);
  const L1_ERC20 = ERC20Ethers__factory.connect(l1Erc20Address, l1Provider);
  const L2_ERC20 = L2StandardERC20Ethers__factory.connect(l2Erc20Address, l2Provider);

  assert((await L2_ERC20.l1Token()) === L1_ERC20.address, "L2 token does not correspond to L1 token");
  return L1StandardBridge.depositETH(2000000, "0x", { value: amount });
}

/**
 * Wait a L1 transaction to be relayed by the L1 Cross Domain Messenger
 * @param tx The L1 -> L2 transaction
 * @param l1RpcProvider Layer 1 RPC provider
 * @param l2RpcProvider Layer 2 RPC provider
 * @returns The transaction receipt
 */
export async function waitRelayToL2(
  tx: ContractTransaction,
  l1RpcProvider: providers.Provider,
  l2RpcProvider: providers.Provider
): Promise<TransactionReceipt> {
  const l2Messenger = new ethers.Contract(
    predeploys.L2CrossDomainMessenger,
    getContractInterface("L2CrossDomainMessenger"),
    l2RpcProvider
  );
  const l1Messenger = new ethers.Contract(
    await l2Messenger.l1CrossDomainMessenger(),
    getContractInterface("L1CrossDomainMessenger"),
    l1RpcProvider
  );

  // Watch for messages to be relayed between L1 and L2.
  const watcher = new Watcher({
    l1: {
      provider: l1RpcProvider,
      messengerAddress: l1Messenger.address,
    },
    l2: {
      provider: l2RpcProvider,
      messengerAddress: l2Messenger.address,
    },
  });

  // Wait for the message to be relayed to L2
  const [msgHash1] = await watcher.getMessageHashesFromL1Tx(tx.hash);
  return watcher.getL2TransactionReceipt(msgHash1, true);
}
