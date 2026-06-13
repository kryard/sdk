/** KryardDelegate ABI fragment — execute + gas-reimbursement + events. */
export const KRYARD_DELEGATE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeWithGasReimbursement",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
      { name: "gasToken", type: "address" },
      { name: "gasTokenAmount", type: "uint256" },
      { name: "relayer", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "GasReimbursed",
    inputs: [
      { name: "relayer", type: "address", indexed: true },
      { name: "gasToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
