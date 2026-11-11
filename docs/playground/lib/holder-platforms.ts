export const holderExplorers: Record<number, { name: string; url: string }> = {
  1: { name: "Ethereum", url: "https://eth.blockscout.com" },
  10: { name: "Optimism", url: "https://optimism.blockscout.com" },
  100: { name: "Gnosis", url: "https://gnosis.blockscout.com" },
  137: { name: "Polygon", url: "https://polygon.blockscout.com" },
  42161: { name: "Arbitrum One", url: "https://arbitrum.blockscout.com" },
  8453: { name: "Base", url: "https://base.blockscout.com" },
};

const geckoChains: Record<string, number> = {
  ethereum: 1, "optimistic-ethereum": 10, "binance-smart-chain": 56, "xdai": 100,
  "polygon-pos": 137, "arbitrum-one": 42161, base: 8453,
};

const reviewedPrimaryChains: Record<string, number> = {
  // ARB is minted on Arbitrum One, not on the Ethereum bridge contract.
  arbitrum: 42161,
};

type Platform = { contractChainId: number; contractAddress: string };

export function geckoHolderPlatforms(platforms: Record<string, string>, primary?: string) {
  const entries = Object.entries(platforms);
  const preferred = entries.find(([chain]) => chain === primary);
  return (preferred ? [preferred, ...entries.filter((entry) => entry !== preferred)] : entries)
    .map(([chain, contractAddress]) => ({ contractChainId: geckoChains[chain], contractAddress }));
}

export function supportedHolderPlatforms(platforms: Platform[], identity?: string) {
  const seen = new Set<string>();
  const supported = platforms.filter(({ contractChainId, contractAddress }) => {
    if (!(contractChainId === 56 || holderExplorers[contractChainId]) || !/^0x[0-9a-f]{40}$/i.test(contractAddress)) return false;
    const key = `${contractChainId}:${contractAddress.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const reviewed = identity && reviewedPrimaryChains[identity];
  const primary = reviewed && supported.find(({ contractChainId }) => contractChainId === reviewed);
  return primary ? [primary, ...supported.filter((platform) => platform !== primary)] : supported;
}
