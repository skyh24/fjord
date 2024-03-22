import { appendFileSync } from "node:fs";

import { createPublicClient, decodeEventLog, decodeFunctionData, formatUnits, http, parseAbi } from "viem";
import { mainnet } from 'viem/chains';

export const ethClient = createPublicClient({
  // cacheTime: 10_000, 
  // pollingInterval: 4_000, 
  chain: mainnet,
  transport: http(process.env.ETH_RPC, {
    batch: {
      batchSize: 20,
      wait: 16
    }
  }),
  batch: {
    multicall: {
      batchSize: 512, 
      wait: 16, 
    }
  }
});

const headers = {
  'Ok-Access-Key': process.env.OKLINK_KEY,
};

const base = 'https://www.oklink.com/api/v5/explorer/address/transaction-list?';
const ADDRESS = process.env.ADDRESS;
const SYMBOL = process.env.SYMBOL;

// OKlink 获取交易
async function fetchAddressTxs(address: string, page: string){
  const query = new URLSearchParams({
    chainShortName: 'ETH',
    protocolType: 'transaction',
    address,
    page,
    limit: '100',
  });
  const url = base + query;
  console.log(url);

  const resp = await fetch( url , { headers });
  const json = await resp.json();

  const totalPage = json.data[0].totalPage as number;
  const txHashes = [];
  for (const tx of json.data[0].transactionLists){
    txHashes.push(tx.txId);
  }
  return { totalPage, txHashes };
}

const abi = parseAbi([
  'function swapExactAssetsForShares(uint256 assetsIn, uint256 minSharesOut, address recipient) returns (uint256 sharesOut)',
  'function swapAssetsForExactShares(uint256 sharesOut, uint256 maxAssetsIn, address recipient) returns (uint256 assetsIn)',
  'function swapExactSharesForAssets(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256 assetsOut)',
  'function swapSharesForExactAssets(uint256 assetsOut, uint256 maxSharesIn, address recipient) returns (uint256 sharesIn)',
  'function redeem(address recipient, bool referred) returns (uint256 shares)',
  'event Buy(address indexed caller, uint256 assets, uint256 shares, uint256 swapFee)',
  'event Sell(address indexed caller, uint256 shares, uint256 assets, uint256 swapFee)',
  'event Redeem(address indexed caller, uint256 indexed streamID, uint256 shares)',
  'function asset() returns (address)',
  'function share() returns (address)',
  // 'function redeem(address recipient, bool referred) returns (uint256 shares)',
])

const erc20ABI = parseAbi([
  'function name() returns (string)',
  'function symbol() returns (string)',
  'function decimals() returns (uint8)',
])
let assetDecimals = 6
let shareDecimals = 18
async function contractUnit(address: string){
  const LBPContract = {
    address,
    abi
  } as const
  const [assetAddr, shareAddr] = await ethClient.multicall({
    contracts: [
      {
        ...LBPContract,
        functionName: 'asset',
      },
      {
        ...LBPContract,
        functionName: 'share',
      },
    ]
  })
  console.log(assetAddr.result, shareAddr.result);
  
  const assetContract = {
    address: assetAddr.result,
    abi: erc20ABI
  } as const
  const shareContract = {
    address: shareAddr.result,
    abi: erc20ABI
  } as const
  const [assetDec, shareDec] = await ethClient.multicall({
    contracts: [
      {
        ...assetContract,
        functionName: 'decimals',
      },
      {
        ...shareContract,
        functionName: 'decimals',
      },
    ]
  })
  console.log(assetDec.result, shareDec.result);
  assetDecimals = assetDec.result as number
  shareDecimals = shareDec.result as number
}

// contractUnit(ADDRESS);

// 写入文件
async function writeTxArgs(hashes : string[]){
  for (let i = 0; i < hashes.length; i++){
    const hash = hashes[i];
    if (hasTxs.includes(hash)) {
      console.log("skip", hash);
      continue;
    }
    // const tx = await ethClient.getTransaction({ hash });
    const txReceipt = await ethClient.getTransactionReceipt({ hash });
    // const [tx, txReceipt] = await Promise.all([
    //   ethClient.getTransaction({ hash }),
    //   ethClient.getTransactionReceipt({ hash }),
    // ]);
    // console.log(hash, tx.hash, txReceipt.transactionHash);
    if (txReceipt.status != "success"){
      console.log(hash, txReceipt.status);
      continue;
    }

    let decoded = {};
    if (txReceipt.logs && txReceipt.logs.length > 0){
      const log = txReceipt.logs[1];
      const data = log.data;
      const topics = log.topics;
      decoded = decodeEventLog({ abi, data, topics });
      // console.log(decoded);
    } else {
      console.log("decode fault",  hash, txReceipt);
      continue;
    }

    if (decoded.eventName == 'Redeem') {
      console.log("finish Redeem", hash);
      break;
    }
    // console.log(tx);
    // const from = tx.from;
    // const blockNumber = tx.blockNumber;
    // const data = tx.input;
    // const { functionName, args } = decodeFunctionData({
    //   abi, data
    // })
    // console.log(hash, blockNumber, functionName, ...args);

    const blockNumber = txReceipt.blockNumber;
    const eventName = decoded.eventName;
    const caller = decoded.args.caller;
    const assets = formatUnits(decoded.args.assets, assetDecimals);
    const shares = formatUnits(decoded.args.shares, shareDecimals);
    const swapFee = formatUnits(decoded.args.swapFee, assetDecimals);

    console.log(hash, blockNumber, eventName, assets, shares, swapFee);
    appendFileSync(SYMBOL + ".txt", hash + '\t' + blockNumber + '\t' + caller + '\t' + 
    eventName + '\t' + assets + '\t\t' + shares + '\t\t' + swapFee + '\n', "utf8");
  }  
}

// 断点续传
const hasTxs: string[] = [];
async function reloadTxs() {
  const file = Bun.file(SYMBOL + ".txt")
  const text = await file.text();
  const lines = text.split('\n');
  console.log(SYMBOL + ".txt" + lines.length);
  
  for (const line of lines){ 
    if (line == '') continue;   
    const args = line.split('\t');    
    hasTxs.push(args[0]);    
  }
}

async function main(){
  await reloadTxs();
  await contractUnit(ADDRESS);

  let total = 1;
  for (let i = 1; i <= total; i++){
    const { totalPage, txHashes } = await fetchAddressTxs(ADDRESS, i.toString());
    console.log(i, totalPage);
    total = totalPage;

    const hashes = txHashes //.slice(0, 3); /// 3
    // console.log(hashes);
    await writeTxArgs(hashes);
  }
}
main();
// TODO：还有新交易没更新，不一定全
/// 1. 解析交易
/// 2. 解析事件
/// 3. 批量获取交易
/// 4. 断点续传
/// 5. 读取合约信息
/// 6. 读取OKlink交易



// // ### Write file
// console.log("write file");
// const swapfile = Bun.file('swap.txt')
// for (const args of allTxArgs){
//   swapfile.write(args.join('\t') + '\n');
// }


/// ### Batch fetch
// 0x5959dee0ed16d904ac9ccfc1e843bf51ac658e6964f1eedc8523fef74cf0604f
// 0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59
// 0x3f0bb4cf272a257281d6b739fe3c2a735e916508d779e217bced8ed05bac2507 

// const results =  await Promise.all([
//     ethClient.getTransaction({ hash: "0x5959dee0ed16d904ac9ccfc1e843bf51ac658e6964f1eedc8523fef74cf0604f" }),
//     ethClient.getTransactionReceipt({ hash: "0x5959dee0ed16d904ac9ccfc1e843bf51ac658e6964f1eedc8523fef74cf0604f" }),
//     ethClient.getTransaction({ hash: "0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59" }),
//     ethClient.getTransactionReceipt({ hash: "0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59" }),
//     ethClient.getTransaction({ hash: "0x3f0bb4cf272a257281d6b739fe3c2a735e916508d779e217bced8ed05bac2507" }),
//     ethClient.getTransactionReceipt({ hash: "0x3f0bb4cf272a257281d6b739fe3c2a735e916508d779e217bced8ed05bac2507" }),
//   ]);

// for (const result of results){
//   if (result.logs && result.logs.length > 0){
//     const log = result.logs[1];
//     const data = log.data;
//     const topics = log.topics;
//     const decoded = decodeEventLog({ abi, data, topics });
//     console.log(decoded);
//   }
// }

// const topics = decodeEventLog({
//   abi,
//   data: "0x000000000000000000000000000000000000000000000000000000029e185d700000000000000000000000000000000000000000000005f1e02590c903525121000000000000000000000000000000000000000000000000000000000d66e326",
//   topics: [ "0xbeae048c6d270d9469f86cf6e8fedda3c60ad770f16c24c9fc131c8e9a09101d",
//     "0x000000000000000000000000f0d40378cccf031b179577f14f6febb494d2264d"
//   ]
// })
// console.log(topics);

// {
//   blockHash: "0x22e82ffadef2c4bab142ff58b1df5c364a406a25a4a5d146efa26c290d226695",
//   blockNumber: 19480156n,
//   contractAddress: null,
//   cumulativeGasUsed: 9026189n,
//   effectiveGasPrice: 27023703734n,
//   from: "0xf0d40378cccf031b179577f14f6febb494d2264d",
//   gasUsed: 110664n,
//   logs: [
//     {
//       address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
//       blockHash: "0x22e82ffadef2c4bab142ff58b1df5c364a406a25a4a5d146efa26c290d226695",
//       blockNumber: 19480156n,
//       data: "0x000000000000000000000000000000000000000000000000000000029e185d70",
//       logIndex: 223,
//       removed: false,
//       topics: [ "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
//         "0x000000000000000000000000f0d40378cccf031b179577f14f6febb494d2264d", "0x000000000000000000000000a2d8f923cb02c94445d3e027ad4ee3df4a167dbd"
//       ],
//       transactionHash: "0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59",
//       transactionIndex: 137,
//     }, {
//       address: "0xa2d8f923cb02c94445d3e027ad4ee3df4a167dbd",
//       blockHash: "0x22e82ffadef2c4bab142ff58b1df5c364a406a25a4a5d146efa26c290d226695",
//       blockNumber: 19480156n,
//       data: "0x000000000000000000000000000000000000000000000000000000029e185d700000000000000000000000000000000000000000000005f1e02590c903525121000000000000000000000000000000000000000000000000000000000d66e326",
//       logIndex: 224,
//       removed: false,
//       topics: [ "0xbeae048c6d270d9469f86cf6e8fedda3c60ad770f16c24c9fc131c8e9a09101d",
//         "0x000000000000000000000000f0d40378cccf031b179577f14f6febb494d2264d"
//       ],
//       transactionHash: "0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59",
//       transactionIndex: 137,
//     }
//   ],
//   logsBloom: "0x00000008000008000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000002000000000000010000000000000000000000000000108000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400010000000000000000000000000000000000000000000000000000000008100000000100000000000000000000000000080000000000100000000000000000800000000000000000002000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000",
//   status: "success",
//   to: "0xa2d8f923cb02c94445d3e027ad4ee3df4a167dbd",
//   transactionHash: "0x7bbf3b2f1d2f2772952d42df7372be0ffdbfbd46039ea8c3a6f37bb54c49ba59",
//   transactionIndex: 137,
//   type: "eip1559",
// }

