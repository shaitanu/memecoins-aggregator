import { useEffect, useMemo, useState } from "react";

type Token = {
  token_address: string;
  token_name?: string;
  token_ticker?: string;
  price?: number;
  volume?: number;
  liquidity?: number;
  market_cap?: number;
  price_24h_change?: number;
};

export default function App() {
  const [tokens, setTokens] = useState<Record<string, Token>>({});
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("volume");

  // NEW FILTER STATE
  const [filterField, setFilterField] = useState("price");
  const [filterOp, setFilterOp] = useState(">=");
  const [filterValue, setFilterValue] = useState("");

  // Load initial data
  useEffect(() => {
    fetch("http://localhost:3000/discover?limit=100&sort=volume")
      .then((res) => res.json())
      .then((data) => {
        const map: Record<string, Token> = {};
        data.tokens.forEach((t: Token) => (map[t.token_address] = t));
        setTokens(map);
      });
  }, []);

  // WebSocket updates
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:4000");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const { address, diff } = msg;

        setTokens((prev) => {
          const updated = { ...prev };
          if (!updated[address]) return prev;
          updated[address] = { ...updated[address], ...diff };
          return updated;
        });
      } catch {}
    };
    return () => ws.close();
  }, []);

  // Filtering & sorting combined
  const filteredTokens = useMemo(() => {
    let list = Object.values(tokens);

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.token_name?.toLowerCase().includes(q) ||
          t.token_ticker?.toLowerCase().includes(q) ||
          t.token_address.toLowerCase().includes(q)
      );
    }

    // Value filter
    if (filterValue !== "") {
      const num = Number(filterValue);

      list = list.filter((t) => {
        const value = (t as any)[filterField];
        if (value == null) return false;

        if (filterOp === ">=") return value >= num;
        if (filterOp === "<=") return value <= num;
        return true;
      });
    }

    // Sorting
    list = list.sort((a, b) => {
      const A = (a as any)[sortBy] ?? -Infinity;
      const B = (b as any)[sortBy] ?? -Infinity;
      return B - A;
    });

    return list;
  }, [tokens, search, sortBy, filterField, filterOp, filterValue]);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <h1 className="text-3xl font-bold mb-6">🔥 Solana Meme Coins (Live)</h1>

      {/* FILTER BAR */}
      <div className="flex flex-wrap gap-4 mb-6">

        {/* SEARCH */}
        <input
          className="px-4 py-2 rounded bg-gray-900 border border-gray-800 text-sm w-64"
          placeholder="Search token..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {/* SORT */}
        <select
          className="px-3 py-2 rounded bg-gray-900 border border-gray-800 text-sm"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="volume">Volume</option>
          <option value="price">Price</option>
          <option value="liquidity">Liquidity</option>
          <option value="market_cap">Market Cap</option>
          <option value="price_24h_change">24h % Change</option>
        </select>

        {/* FILTER FIELD */}
        <select
          className="px-3 py-2 rounded bg-gray-900 border border-gray-800 text-sm"
          value={filterField}
          onChange={(e) => setFilterField(e.target.value)}
        >
          <option value="price">Price</option>
          <option value="volume">Volume</option>
          <option value="liquidity">Liquidity</option>
          <option value="market_cap">Market Cap</option>
        </select>

        {/* OPERATOR */}
        <select
          className="px-3 py-2 rounded bg-gray-900 border border-gray-800 text-sm"
          value={filterOp}
          onChange={(e) => setFilterOp(e.target.value)}
        >
          <option value=">=">≥</option>
          <option value="<=">≤</option>
        </select>

        {/* VALUE */}
        <input
          type="number"
          className="px-4 py-2 rounded bg-gray-900 border border-gray-800 text-sm w-32"
          placeholder="Value"
          value={filterValue}
          onChange={(e) => setFilterValue(e.target.value)}
        />
      </div>

      {/* TABLE */}
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-900 text-gray-400 uppercase text-xs">
            <tr>
              <th className="p-3">Token</th>
              <th className="p-3 text-right">Price</th>
              <th className="p-3 text-right">24h%</th>
              <th className="p-3 text-right">Volume</th>
              <th className="p-3 text-right">Liquidity</th>
            </tr>
          </thead>

          <tbody>
            {filteredTokens.map((t) => (
              <tr
                key={t.token_address}
                className="border-t border-gray-800 hover:bg-gray-900 transition"
              >
                <td className="p-3">
                  <div className="font-semibold">{t.token_name}</div>
                  <div className="text-xs text-gray-500">
                    {t.token_ticker} · {t.token_address.slice(0, 6)}...
                  </div>
                </td>

                <td className="p-3 text-right">
                  {t.price?.toFixed(8)}
                </td>

                <td
                  className={`p-3 text-right ${
                    (t.price_24h_change ?? 0) >= 0
                      ? "text-green-400"
                      : "text-red-400"
                  }`}
                >
                  {t.price_24h_change?.toFixed(2)}%
                </td>

                <td className="p-3 text-right">
                  {t.volume?.toFixed(2)}
                </td>

                <td className="p-3 text-right">
                  {t.liquidity?.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
