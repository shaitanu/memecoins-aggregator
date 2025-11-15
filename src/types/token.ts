export type TokenDto = {
  token_address: string;

  token_name?: string;
  token_ticker?: string;

  price?: number;
  market_cap?: number;
  volume?: number;
  liquidity?: number;

  transaction_count?: number;

  price_1h_change?: number;
  price_24h_change?: number;
  price_7d_change?: number;

  protocol?: string;

  source?: string;
  fetched_at?: number;
};
