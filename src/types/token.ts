export type TokenDto = {
  token_address: string;
  token_name?: string;
  token_ticker?: string;
  price_sol?: number;
  market_cap_sol?: number;
  volume_sol?: number;
  liquidity_sol?: number;
  transaction_count?: number;
  price_1h_change?: number;
  source?: string;       
  fetched_at?: number;   
};
