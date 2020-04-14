export function extractFirstPartSymbol(symbol: string) {
  return symbol.substring(0, symbol.indexOf('/'));
}

export function extractSencondPartSymbol(symbol: string) {
  return symbol.substring(symbol.indexOf('/') +1);
}
