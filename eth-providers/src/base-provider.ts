import { checkSignatureType, Eip712Transaction, parseTransaction } from '@setheum.js/eth-transactions';
import type { EvmAccountInfo, EvmContractInfo } from '@setheum.js/types/interfaces';
import {
  EventType,
  FeeData,
  Filter,
  Listener,
  Log,
  Provider as AbstractProvider,
  Provider,
  TransactionReceipt,
  TransactionRequest,
  TransactionResponse
} from '@ethersproject/abstract-provider';
import { getAddress } from '@ethersproject/address';
import { hexDataLength, hexlify, hexValue, isHexString, joinSignature } from '@ethersproject/bytes';
import { Logger } from '@ethersproject/logger';
import { Network } from '@ethersproject/networks';
import { Deferrable, defineReadOnly, resolveProperties } from '@ethersproject/properties';
import { Formatter } from '@ethersproject/providers';
import { accessListify, Transaction } from '@ethersproject/transactions';
import { ApiPromise } from '@polkadot/api';
import { createHeaderExtended } from '@polkadot/api-derive';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import type { GenericExtrinsic, Option } from '@polkadot/types';
import type { AccountId, Header } from '@polkadot/types/interfaces';
import type BN from 'bn.js';
import { BigNumber, BigNumberish } from 'ethers';
import {
  BIGNUMBER_ZERO,
  EFFECTIVE_GAS_PRICE,
  EMPTY_STRING,
  GAS_PRICE,
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE_PER_GAS,
  U32MAX,
  U64MAX,
  ZERO
} from './consts';
import {
  computeDefaultEvmAddress,
  computeDefaultSubstrateAddress,
  convertNativeToken,
  getFilteredLogs,
  getPartialTransactionReceipt,
  getTxReceiptByHash,
  logger,
  sendTx,
  throwNotImplemented
} from './utils';
import { TransactionReceipt as TransactionReceiptGQL } from './utils/gqlTypes';
import { UnfinalizedBlockCache } from './utils/unfinalizedBlockCache';

export type BlockTag = 'earliest' | 'latest' | 'pending' | string | number;
export type Signature = 'Ethereum' | 'SetheumEip712' | 'Substrate';

// https://github.com/ethers-io/ethers.js/blob/master/packages/abstract-provider/src.ts/index.ts#L61
export interface _Block {
  hash: string;
  parentHash: string;
  number: number;

  timestamp: number;
  nonce: string;
  difficulty: number;

  gasLimit: BigNumber;
  gasUsed: BigNumber;

  miner: string;
  extraData: string;

  // eslint-disable-next-line @rushstack/no-new-null
  baseFeePerGas?: null | BigNumber;
}

export interface _RichBlock extends _Block {
  stateRoot: string;
  transactionsRoot: string;
  author: string;
  mixHash: string;
}

export interface RichBlock extends _RichBlock {
  transactions: Array<string>;
}

export interface BlockWithTransactions extends _RichBlock {
  transactions: Array<TransactionResponse>;
}

export interface CallRequest {
  from?: string;
  to?: string;
  gasLimit?: BigNumberish;
  storageLimit?: BigNumberish;
  value?: BigNumberish;
  data?: string;
}

export interface partialTX {
  from: string;
  to: string | null;
  blockHash: string;
  blockNumber: number;
  transactionIndex: number;
}

export interface TX extends partialTX {
  hash: string;
  nonce: number;
  value: BigNumberish;
  gasPrice: BigNumber;
  gas: BigNumberish;
  input: string;
}

export interface TXReceipt extends partialTX {
  contractAddress: string | null;
  root?: string;
  gasUsed: BigNumber;
  logsBloom: string;
  transactionHash: string;
  logs: Array<Log>;
  confirmations: number;
  cumulativeGasUsed: BigNumber;
  effectiveGasPrice: BigNumber;
  type: number;
  status?: number;
}

export abstract class BaseProvider extends AbstractProvider {
  readonly _api?: ApiPromise;
  readonly formatter: Formatter;

  _network?: Network;
  _cache?: UnfinalizedBlockCache;

  constructor() {
    super();
    this.formatter = new Formatter();
  }

  startCache = async (): Promise<any> => {
    this._cache = new UnfinalizedBlockCache();

    await this.isReady();

    this.api.rpc.chain.subscribeNewHeads(async (header: Header) => {
      const blockNumber = header.number.toNumber();
      const blockHash = (await this.api.rpc.chain.getBlockHash(blockNumber)).toHex();
      const txHashes = await this._getTxHashesAtBlock(blockHash);

      this._cache!.addTxsAtBlock(blockNumber, txHashes);
    }) as unknown as void;

    this.api.rpc.chain.subscribeFinalizedHeads(async (header: Header) => {
      this._cache!.removeTxsAtBlock(header.number.toNumber());
    }) as unknown as void;
  };

  setApi = (api: ApiPromise): void => {
    defineReadOnly(this, '_api', api);
  };

  get api(): ApiPromise {
    if (!this._api) {
      return logger.throwError('the api needs to be set', Logger.errors.UNKNOWN_ERROR);
    }

    return this._api;
  }

  get genesisHash(): string {
    return this.api.genesisHash.toHex();
  }

  get isConnected(): boolean {
    return this.api.isConnected;
  }

  get chainDecimal(): number {
    return this.api.registry.chainDecimals[0] || 10;
  }

  isReady = async (): Promise<Network> => {
    if (!this._network) {
      try {
        await this.api.isReadyOrError;

        const network = {
          name: this.api.runtimeVersion.specName.toString(),
          chainId: await this.chainId()
        };

        this._network = network;
      } catch (e) {
        await this.api.disconnect();
        throw e;
      }
    }

    return this._network;
  };

  disconnect = async (): Promise<void> => {
    await this.api.disconnect();
  };

  getNetwork = async (): Promise<Network> => {
    const network = await this.isReady();

    return network;
  };

  netVersion = async (): Promise<string> => {
    return this.api.consts.evm.chainId.toString();
  };

  chainId = async (): Promise<number> => {
    await this.api.isReadyOrError;
    return (this.api.consts.evm.chainId as any).toNumber();
  };

  getBlockNumber = async (): Promise<number> => {
    await this.getNetwork();

    const blockHash = await this._getBlockTag('latest');
    const header = await this.api.rpc.chain.getHeader(blockHash);
    return header.number.toNumber();
  };

  getBlock = async (
    blockTag: BlockTag | string | Promise<BlockTag | string>,
    full?: boolean | Promise<boolean>
  ): Promise<RichBlock> => {
    await this.getNetwork();
    // @TODO
    if (full) {
      return logger.throwError('getBlock full param not implemented', Logger.errors.UNSUPPORTED_OPERATION);
    }

    const { fullTx, blockHash } = await resolveProperties({
      blockHash: this._getBlockTag(blockTag),
      fullTx: full
    });

    const apiAt = await this.api.at(blockHash);

    const [block, header, validators, now] = await Promise.all([
      this.api.rpc.chain.getBlock(blockHash),
      this.api.rpc.chain.getHeader(blockHash),
      this.api.query.session ? apiAt.query.session.validators() : ([] as any),
      apiAt.query.timestamp.now()
      // apiAt.query.system.events(),
    ]);

    const headerExtended = createHeaderExtended(header.registry, header, validators);

    const deafultNonce = this.api.registry.createType('u64', 0);
    const deafultMixHash = this.api.registry.createType('u256', 0);

    const author = headerExtended.author ? await this.getEvmAddress(headerExtended.author.toString()) : EMPTY_STRING;

    return {
      hash: headerExtended.hash.toHex(),
      parentHash: headerExtended.parentHash.toHex(),
      number: headerExtended.number.toNumber(),
      stateRoot: headerExtended.stateRoot.toHex(),
      transactionsRoot: headerExtended.extrinsicsRoot.toHex(),
      timestamp: now.toNumber(),
      nonce: deafultNonce.toHex(),
      mixHash: deafultMixHash.toHex(),
      difficulty: ZERO,
      gasLimit: BigNumber.from(15000000), // 15m for now. TODO: query this from blockchain
      gasUsed: BIGNUMBER_ZERO,

      miner: author,
      author: author,
      extraData: EMPTY_STRING,

      baseFeePerGas: BIGNUMBER_ZERO,
      transactions: block.block.extrinsics.map((e) => e.hash.toHex()) // When the full parameter is true, it should return TransactionReceipt
    };
  };

  getBlockWithTransactions = async (
    blockTag: BlockTag | string | Promise<BlockTag | string>
  ): Promise<BlockWithTransactions> => {
    // @TODO implementing full
    return this.getBlock(blockTag, true) as any;
  };

  // @TODO free
  getBalance = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<BigNumber> => {
    await this.getNetwork();

    const { address, blockHash } = await resolveProperties({
      address: this._getAddress(addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const substrateAddress = await this.getSubstrateAddress(address, blockHash);

    const apiAt = await this.api.at(blockHash);

    const accountInfo = await apiAt.query.system.account(substrateAddress);

    return convertNativeToken(BigNumber.from(accountInfo.data.free.toBigInt()), this.chainDecimal);
  };

  getTransactionCount = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> => {
    return this.getEvmTransactionCount(addressOrName, blockTag);
  };

  getEvmTransactionCount = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> => {
    await this.getNetwork();

    const accountInfo = await this.queryAccountInfo(addressOrName, blockTag);

    return !accountInfo.isNone ? accountInfo.unwrap().nonce.toNumber() : 0;
  };

  getSubstrateNonce = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> => {
    await this.getNetwork();

    const address = await this._getAddress(addressOrName);
    const resolvedBlockTag = await blockTag;

    const substrateAddress = await this.getSubstrateAddress(address);

    if (resolvedBlockTag === 'pending') {
      const idx = await this.api.rpc.system.accountNextIndex(substrateAddress);
      return idx.toNumber();
    }

    const blockHash = await this._getBlockTag(blockTag);

    const apiAt = await this.api.at(blockHash);
    const accountInfo = await apiAt.query.system.account(substrateAddress);

    return accountInfo.nonce.toNumber();
  };

  getCode = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> => {
    await this.getNetwork();

    const { address, blockHash } = await resolveProperties({
      address: this._getAddress(addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const contractInfo = await this.queryContractInfo(address, blockHash);

    if (contractInfo.isNone) {
      return '0x';
    }

    const codeHash = contractInfo.unwrap().codeHash;

    const api = await (blockHash ? this.api.at(blockHash) : this.api);

    const code = await api.query.evm.codes(codeHash);

    return code.toHex();
  };

  call = async (
    transaction: Deferrable<TransactionRequest>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> => {
    await this.getNetwork();

    const resolved = await resolveProperties({
      transaction: this._getTransactionRequest(transaction),
      blockHash: this._getBlockTag(blockTag)
    });

    if (!resolved.transaction.from) {
      return '0x';
    }

    const callRequest: CallRequest = {
      from: resolved.transaction.from,
      to: resolved.transaction.to,
      gasLimit: resolved.transaction.gasLimit?.toBigInt(),
      storageLimit: undefined,
      value: resolved.transaction.value?.toBigInt(),
      data: resolved.transaction.data
    };

    const data = resolved.blockHash
      ? await (this.api.rpc as any).evm.call(callRequest, resolved.blockHash)
      : await (this.api.rpc as any).evm.call(callRequest);

    return data.toHex();
  };

  getStorageAt = async (
    addressOrName: string | Promise<string>,
    position: BigNumberish | Promise<BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> => {
    await this.getNetwork();

    // @TODO resolvedPosition
    const { address, blockHash, resolvedPosition } = await resolveProperties({
      address: this._getAddress(addressOrName),
      blockHash: this._getBlockTag(blockTag),
      resolvedPosition: Promise.resolve(position).then((p) => hexValue(p))
    });

    const apiAt = await this.api.at(blockHash);

    const code = await apiAt.query.evm.accountStorages(address, position);

    return code.toHex();
  };

  // @TODO
  resolveName = async (name: string | Promise<string>): Promise<string> => {
    name = await name;

    return name;
    // If it is already an address, nothing to resolve
    // try {
    //   return Promise.resolve(this.formatter.address(name));
    // } catch (error) {
    //   // If is is a hexstring, the address is bad (See #694)
    //   if (isHexString(name)) {
    //     throw error;
    //   }
    // }

    // if (typeof name !== 'string') {
    //   logger.throwArgumentError('invalid ENS name', 'name', name);
    // }

    // // Get the addr from the resovler
    // const resolver = await this.getResolver(name);
    // if (!resolver) {
    //   return null;
    // }

    // return await resolver.getAddress();
  };

  getGasPrice = async (): Promise<BigNumber> => {
    return GAS_PRICE;
  };

  getFeeData = async (): Promise<FeeData> => {
    return {
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      gasPrice: GAS_PRICE
    };
  };

  /**
   * Estimate gas for a transaction.
   * @param transaction The transaction to estimate the gas of
   * @returns The estimated gas used by this transaction
   */
  estimateGas = async (transaction: Deferrable<TransactionRequest>): Promise<BigNumber> => {
    const resources = await this.estimateResources(transaction);
    return resources.gas;
  };

  /**
   * Estimate resources for a transaction.
   * @param transaction The transaction to estimate the resources of
   * @returns The estimated resources used by this transaction
   */
  estimateResources = async (
    transaction: Deferrable<TransactionRequest>
  ): Promise<{
    gas: BigNumber;
    storage: BigNumber;
    weightFee: BigNumber;
  }> => {
    const ethTx = await this._getTransactionRequest(transaction);

    if (!ethTx.from) {
      return logger.throwArgumentError('missing from address', 'transaction', ethTx);
    }

    const { from, to, data, value } = ethTx;

    const extrinsic = !to
      ? this.api.tx.evm.create(
          data,
          value?.toBigInt(),
          U64MAX.toBigInt(), // gas_limit u64::max
          U32MAX.toBigInt() // storage_limit u32::max
        )
      : this.api.tx.evm.call(
          to,
          data,
          value?.toBigInt(),
          U64MAX.toBigInt(), // gas_limit u64::max
          U32MAX.toBigInt() // storage_limit u32::max
        );

    const result = await (this.api.rpc as any).evm.estimateResources(from, extrinsic.toHex());

    return {
      gas: BigNumber.from((result.gas as BN).toString()),
      storage: BigNumber.from((result.storage as BN).toString()),
      weightFee: BigNumber.from((result.weightFee as BN).toString())
    };
  };

  getSubstrateAddress = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> => {
    const { address, blockHash } = await resolveProperties({
      address: this._getAddress(addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const apiAt = await this.api.at(blockHash);

    const substrateAccount = await apiAt.query.evmAccounts.accounts<Option<AccountId>>(address);

    return substrateAccount.isEmpty ? computeDefaultSubstrateAddress(address) : substrateAccount.toString();
  };

  getEvmAddress = async (
    substrateAddress: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> => {
    substrateAddress = await substrateAddress;

    const { blockHash } = await resolveProperties({
      blockHash: this._getBlockTag(blockTag)
    });

    const apiAt = await this.api.at(blockHash);

    const evmAddress = await apiAt.query.evmAccounts.evmAddresses(substrateAddress);

    return getAddress(evmAddress.isEmpty ? computeDefaultEvmAddress(substrateAddress) : evmAddress.toString());
  };

  queryAccountInfo = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<Option<EvmAccountInfo>> => {
    // pending tag
    const resolvedBlockTag = await blockTag;
    if (resolvedBlockTag === 'pending') {
      const address = await this._getAddress(addressOrName);
      return this.api.query.evm.accounts<Option<EvmAccountInfo>>(address);
    }

    const { address, blockHash } = await resolveProperties({
      address: this._getAddress(addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const apiAt = await this.api.at(blockHash);

    const accountInfo = await apiAt.query.evm.accounts<Option<EvmAccountInfo>>(address);

    return accountInfo;
  };

  queryContractInfo = async (
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<Option<EvmContractInfo>> => {
    const accountInfo = await this.queryAccountInfo(addressOrName, blockTag);

    if (accountInfo.isNone) {
      return this.api.createType<Option<EvmContractInfo>>('Option<EvmContractInfo>', null);
    }

    return accountInfo.unwrap().contractInfo;
  };

  prepareTransaction = async (
    rawTx: string
  ): Promise<{
    extrinsic: SubmittableExtrinsic<'promise'>;
    transaction: Eip712Transaction;
  }> => {
    await this.getNetwork();

    const signatureType = checkSignatureType(rawTx);
    const ethTx = parseTransaction(rawTx);

    if (!ethTx.from) {
      return logger.throwArgumentError('missing from address', 'transaction', ethTx);
    }

    const storageLimit = ethTx.type === 96 ? ethTx.storageLimit?.toString() : ethTx.gasPrice?.shr(32).toString() ?? 0;
    const validUntil =
      ethTx.type === 96 ? ethTx.validUntil?.toString() : ethTx.gasPrice?.and(0xffffffff).toString() ?? 0;

    const extrinsic = this.api.tx.evm.ethCall(
      ethTx.to ? { Call: ethTx.to } : { Create: null },
      ethTx.data,
      ethTx.value.toString(),
      ethTx.gasLimit.toString(),
      storageLimit,
      validUntil
    );

    const subAddr = await this.getSubstrateAddress(ethTx.from);

    const sig = joinSignature({ r: ethTx.r!, s: ethTx.s, v: ethTx.v });

    extrinsic.addSignature(subAddr, { [signatureType]: sig } as any, {
      blockHash: '0x', // ignored
      era: '0x00', // mortal
      genesisHash: '0x', // ignored
      method: 'Bytes', // don't know waht is this
      nonce: ethTx.nonce,
      specVersion: 0, // ignored
      tip: 0, // need to be zero
      transactionVersion: 0 // ignored
    });

    logger.debug(
      {
        evmAddr: ethTx.from,
        address: subAddr,
        hash: extrinsic.hash.toHex()
      },
      'sending raw transaction'
    );

    return {
      extrinsic,
      transaction: ethTx
    };
  };

  sendRawTransaction = async (rawTx: string): Promise<string> => {
    const { extrinsic } = await this.prepareTransaction(rawTx);

    await extrinsic.send();

    return extrinsic.hash.toHex();
  };

  sendTransaction = async (signedTransaction: string | Promise<string>): Promise<TransactionResponse> => {
    await this.getNetwork();
    const hexTx = await Promise.resolve(signedTransaction).then((t) => hexlify(t));
    const tx = this.formatter.transaction(signedTransaction);

    if (tx.confirmations == null) {
      tx.confirmations = 0;
    }

    try {
      const { extrinsic, transaction } = await this.prepareTransaction(hexTx);
      //@TODO
      // wait for tx in block
      const result = await sendTx(this.api, extrinsic);
      const blockHash = result.status.isInBlock ? result.status.asInBlock : result.status.asFinalized;
      const header = await this.api.rpc.chain.getHeader(blockHash);
      const blockNumber = header.number.toNumber();
      const hash = extrinsic.hash.toHex();

      return this._wrapTransaction(transaction, hash, blockNumber, blockHash.toHex());
    } catch (error) {
      (<any>error).transaction = tx;
      (<any>error).transactionHash = tx.hash;
      throw error;
    }
  };

  _wrapTransaction = async (
    tx: Eip712Transaction,
    hash: string,
    startBlock: number,
    startBlockHash: string
  ): Promise<TransactionResponse> => {
    if (hash != null && hexDataLength(hash) !== 32) {
      throw new Error('invalid hash - sendTransaction');
    }

    // Check the hash we expect is the same as the hash the server reported
    // @TODO expectedHash
    // if (hash != null && tx.hash !== hash) {
    //   logger.throwError('Transaction hash mismatch from Provider.sendTransaction.', Logger.errors.UNKNOWN_ERROR, {
    //     expectedHash: tx.hash,
    //     returnedHash: hash
    //   });
    // }

    const result = <TransactionResponse>tx;

    // fix tx hash
    result.hash = hash;
    result.blockNumber = startBlock;
    result.blockHash = startBlockHash;

    const apiAt = await this.api.at(result.blockHash);
    result.timestamp = (await apiAt.query.timestamp.now()).toNumber();

    result.wait = async (confirms?: number, timeout?: number) => {
      if (confirms === null || confirms === undefined) {
        confirms = 1;
      }
      if (timeout == null) {
        timeout = 0;
      }

      return new Promise((resolve, reject) => {
        const cancelFuncs: Array<() => void> = [];

        let done = false;

        const alreadyDone = function () {
          if (done) {
            return true;
          }
          done = true;
          cancelFuncs.forEach((func) => {
            func();
          });
          return false;
        };

        this.api.rpc.chain
          .subscribeNewHeads((head) => {
            const blockNumber = head.number.toNumber();

            if ((confirms as number) <= blockNumber - startBlock) {
              const receipt = this.getTransactionReceiptAtBlock(hash, startBlockHash);
              if (alreadyDone()) {
                return;
              }
              resolve(receipt);
            }
          })
          .then((unsubscribe) => {
            cancelFuncs.push(() => {
              unsubscribe();
            });
          })
          .catch((error) => {
            reject(error);
          });

        if (typeof timeout === 'number' && timeout > 0) {
          const timer = setTimeout(() => {
            if (alreadyDone()) {
              return;
            }
            reject(logger.makeError('timeout exceeded', Logger.errors.TIMEOUT, { timeout: timeout }));
          }, timeout);

          if (timer.unref) {
            timer.unref();
          }

          cancelFuncs.push(() => {
            clearTimeout(timer);
          });
        }
      });
    };

    return result;
  };

  _getBlockTag = async (blockTag?: BlockTag | Promise<BlockTag>): Promise<string> => {
    blockTag = await blockTag;

    if (blockTag === undefined) {
      blockTag = 'latest';
    }

    switch (blockTag) {
      case 'pending': {
        return logger.throwError('pending tag not implemented', Logger.errors.UNSUPPORTED_OPERATION);
      }
      case 'latest': {
        const hash = await this.api.rpc.chain.getBlockHash();
        return hash.toHex();
      }
      case 'earliest': {
        const hash = this.api.genesisHash;
        return hash.toHex();
      }
      default: {
        if (!isHexString(blockTag)) {
          return logger.throwArgumentError('blocktag should be a hex string', 'blockTag', blockTag);
        }

        // block hash
        if (typeof blockTag === 'string' && isHexString(blockTag, 32)) {
          return blockTag;
        }

        const blockNumber = BigNumber.from(blockTag).toNumber();

        const hash = await this.api.rpc.chain.getBlockHash(blockNumber);

        return hash.toHex();
      }
    }
  };

  _getBlockNumberFromTag = async (blockTag: BlockTag): Promise<number> => {
    switch (blockTag) {
      case 'pending': {
        return logger.throwError('pending tag not implemented', Logger.errors.UNSUPPORTED_OPERATION);
      }
      case 'latest': {
        const header = await this.api.rpc.chain.getHeader();
        return header.number.toNumber();
      }
      case 'earliest': {
        return 0;
      }
      default: {
        if (typeof blockTag !== 'number') {
          return logger.throwArgumentError("blocktag should be number | 'latest' | 'earliest'", 'blockTag', blockTag);
        }

        return blockTag;
      }
    }
  };

  _getAddress = async (addressOrName: string | Promise<string>): Promise<string> => {
    addressOrName = await addressOrName;
    return addressOrName;
  };

  _getTransactionRequest = async (transaction: Deferrable<TransactionRequest>): Promise<Partial<Transaction>> => {
    const values: any = await transaction;

    const tx: any = {};

    ['from', 'to'].forEach((key) => {
      if (values[key] === null || values[key] === undefined) {
        return;
      }
      tx[key] = Promise.resolve(values[key]).then((v) => (v ? this._getAddress(v) : null));
    });

    ['gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value'].forEach((key) => {
      if (values[key] === null || values[key] === undefined) {
        return;
      }
      tx[key] = Promise.resolve(values[key]).then((v) => (v ? BigNumber.from(v) : null));
    });

    ['type'].forEach((key) => {
      if (values[key] === null || values[key] === undefined) {
        return;
      }
      tx[key] = Promise.resolve(values[key]).then((v) => (v !== null || v !== undefined ? v : null));
    });

    if (values.accessList) {
      tx.accessList = accessListify(values.accessList);
    }

    ['data'].forEach((key) => {
      if (values[key] === null || values[key] === undefined) {
        return;
      }
      tx[key] = Promise.resolve(values[key]).then((v) => (v ? hexlify(v) : null));
    });

    return await resolveProperties(tx);
  };

  _getTxHashesAtBlock = async (blockHash: string): Promise<string[]> => {
    const extrinsics = (await this._getExtrinsicsAtBlock(blockHash)) as GenericExtrinsic[];
    return extrinsics.map((e) => e.hash.toHex());
  };

  _getExtrinsicsAtBlock = async (
    blockHash: string,
    txHash?: string
  ): Promise<GenericExtrinsic | GenericExtrinsic[] | undefined> => {
    const block = await this.api.rpc.chain.getBlock(blockHash.toLowerCase());
    const { extrinsics } = block.block;

    if (!txHash) return extrinsics;

    const _txHash = txHash.toLowerCase();
    return extrinsics.find((e) => e.hash.toHex() === _txHash);
  };

  // @TODO Testing
  getTransactionReceiptAtBlock = async (
    hash: string | Promise<string>,
    blockTag: BlockTag | string | Promise<BlockTag | string>
  ): Promise<TransactionReceipt> => {
    const txHash = (await hash).toLowerCase();
    const blockHash = await this._getBlockTag(blockTag);

    const apiAt = await this.api.at(blockHash);

    const [block, header, blockEvents] = await Promise.all([
      this.api.rpc.chain.getBlock(blockHash),
      this.api.rpc.chain.getHeader(blockHash),
      apiAt.query.system.events()
    ]);

    const blockNumber = header.number.toNumber();

    const { extrinsic, extrinsicIndex } =
      block.block.extrinsics
        .map((extrinsic, index) => {
          return {
            extrinsic,
            extrinsicIndex: index
          };
        })
        .find(({ extrinsic }) => extrinsic.hash.toHex() === txHash) || {};

    if (!extrinsic || !extrinsicIndex) {
      return logger.throwError(`transaction hash not found`, Logger.errors.UNKNOWN_ERROR, {
        hash: txHash,
        blockHash
      });
    }

    const events = blockEvents.filter(
      (event) => event.phase.isApplyExtrinsic && event.phase.asApplyExtrinsic.toNumber() === extrinsicIndex
    );

    const evmEvent = events.find(({ event }) => {
      return (
        event.section.toUpperCase() === 'EVM' &&
        ['Created', 'CreatedFailed', 'Executed', 'ExecutedFailed'].includes(event.method)
      );
    });

    if (!evmEvent) {
      return logger.throwError(`evm event not found`, Logger.errors.UNKNOWN_ERROR, {
        hash: txHash,
        blockHash
      });
    }

    const transactionInfo = { transactionIndex: extrinsicIndex, blockHash, transactionHash: txHash, blockNumber };
    const partialTransactionReceipt = getPartialTransactionReceipt(evmEvent);

    // to and contractAddress may be undefined
    return this.formatter.receipt({
      confirmations: (await this._getBlockNumberFromTag('latest')) - blockNumber,
      ...transactionInfo,
      ...partialTransactionReceipt,
      logs: partialTransactionReceipt.logs.map((log) => ({
        ...transactionInfo,
        ...log
      }))
    }) as any;
  };

  static isProvider(value: any): value is Provider {
    return !!(value && value._isProvider);
  }

  _getTxReceiptFromCache = async (txHash: string): Promise<TransactionReceipt | null> => {
    const targetBlockNumber = await this._cache?.getBlockNumber(txHash);
    if (!targetBlockNumber) return null;

    const targetBlockHash = await this.api.rpc.chain.getBlockHash(targetBlockNumber);

    return this.getTransactionReceiptAtBlock(txHash, targetBlockHash.toHex());
  };

  _getTXReceipt = async (txHash: string): Promise<TransactionReceipt | TransactionReceiptGQL> => {
    const [txFromCache, txFromSubql] = await Promise.all([
      this._getTxReceiptFromCache(txHash),
      getTxReceiptByHash(txHash)
    ]);

    return (
      txFromCache ||
      txFromSubql ||
      logger.throwError(`transaction hash not found`, Logger.errors.UNKNOWN_ERROR, { txHash })
    );
  };

  // Queries
  getTransaction = (txHash: string): Promise<TransactionResponse> =>
    throwNotImplemented('getTransaction (deprecated: please use getTransactionByHash)');

  getTransactionByHash = async (txHash: string): Promise<TX> => {
    const tx = await this._getTXReceipt(txHash);

    const extrinsic = await this._getExtrinsicsAtBlock(tx.blockHash, txHash);

    if (!extrinsic) {
      return logger.throwError(`extrinsic not found from hash`, Logger.errors.UNKNOWN_ERROR, { txHash });
    }

    const nonce = (extrinsic as GenericExtrinsic).nonce.toNumber();
    const { args } = (extrinsic as GenericExtrinsic).method.toJSON();
    const input = (args as any).input ?? '';
    const value = (args as any).value ?? 0;

    return {
      from: tx.from,
      to: tx.to || null,
      hash: tx.transactionHash,
      blockHash: tx.blockHash,
      nonce,
      blockNumber: tx.blockNumber,
      transactionIndex: tx.transactionIndex,
      value,
      gasPrice: GAS_PRICE,
      gas: tx.gasUsed,
      input
    };
  };

  getTransactionReceipt = async (txHash: string): Promise<TransactionReceipt> => {
    // @TODO
    // @ts-ignore
    return this.getTXReceiptByHash(txHash);
  };

  getTXReceiptByHash = async (txHash: string): Promise<TXReceipt> => {
    const tx = await this._getTXReceipt(txHash);

    return this.formatter.receipt({
      to: tx.to || null,
      from: tx.from,
      contractAddress: tx.contractAddress || null,
      transactionIndex: tx.transactionIndex,
      gasUsed: tx.gasUsed,
      logsBloom: tx.logsBloom,
      blockHash: tx.blockHash,
      transactionHash: tx.transactionHash,
      logs: Array.isArray(tx.logs) ? tx.logs : (tx.logs.nodes as Log[]),
      blockNumber: tx.blockNumber,
      cumulativeGasUsed: tx.cumulativeGasUsed,
      type: tx.type,
      status: tx.status,
      effectiveGasPrice: EFFECTIVE_GAS_PRICE,
      confirmations: (await this._getBlockNumberFromTag('latest')) - tx.blockNumber
    });
  };

  // Bloom-filter Queries
  getLogs = async (filter: Filter): Promise<Log[]> => {
    const { fromBlock, toBlock } = filter;
    const _filter = { ...filter };

    if (fromBlock) {
      const fromBlockNumber = await this._getBlockNumberFromTag(fromBlock);
      _filter.fromBlock = fromBlockNumber;
    }
    if (toBlock) {
      const toBlockNumber = await this._getBlockNumberFromTag(toBlock);
      _filter.toBlock = toBlockNumber;
    }

    const filteredLogs = await getFilteredLogs(_filter as Filter);

    return filteredLogs.map((log) => this.formatter.filterLog(log));
  };

  // ENS
  lookupAddress = (address: string | Promise<string>): Promise<string> => throwNotImplemented('lookupAddress');

  waitForTransaction = (
    transactionHash: string,
    confirmations?: number,
    timeout?: number
  ): Promise<TransactionReceipt> => throwNotImplemented('waitForTransaction');

  // Event Emitter (ish)
  on = (eventName: EventType, listener: Listener): Provider => throwNotImplemented('on');
  once = (eventName: EventType, listener: Listener): Provider => throwNotImplemented('once');
  emit = (eventName: EventType, ...args: Array<any>): boolean => throwNotImplemented('emit');
  listenerCount = (eventName?: EventType): number => throwNotImplemented('listenerCount');
  listeners = (eventName?: EventType): Array<Listener> => throwNotImplemented('listeners');
  off = (eventName: EventType, listener?: Listener): Provider => throwNotImplemented('off');
  removeAllListeners = (eventName?: EventType): Provider => throwNotImplemented('removeAllListeners');
}
