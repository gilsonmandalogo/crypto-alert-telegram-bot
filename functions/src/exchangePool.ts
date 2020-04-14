import * as ccxt from 'ccxt';

const exchangePool = new Map<string, ccxt.Exchange>();

export const getExchange = (exchangeId: string) => {
  const exchangeFind = exchangePool.get(exchangeId);

  if (exchangeFind) {
    return exchangeFind;
  }

  const exchangeClass: typeof ccxt.Exchange = (ccxt as any)[exchangeId];
  let exchange: ccxt.Exchange;

  try {
    exchange = new exchangeClass({
      enableRateLimit: true,
    });
  } catch {
    throw new Error(`Exchange "${exchangeId}" not supported`);
  }

  exchangePool.set(exchangeId, exchange);
  return exchange;
}
