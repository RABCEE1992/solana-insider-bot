module.exports = async (req, res) => {
  const { default: fetch } = await import('node-fetch');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: Auth check (match Helius header if set)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader !== `Bearer ${process.env.AUTH_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let data;
  try {
    data = await req.json();
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(200).json({ message: 'No transactions to process' });
  }

  const watchedWallets = JSON.parse(process.env.WATCHED_WALLETS || '[]');
  if (watchedWallets.length === 0) {
    return res.status(500).json({ error: 'No watched wallets configured' });
  }

  for (const tx of data) {
    // Focus on transfers (Helius tags as 'TRANSFER' for SPL tokens)
    if (tx.type !== 'TRANSFER' || !tx.tokenTransfers) continue;

    for (const transfer of tx.tokenTransfers) {
      // Check if incoming to a watched wallet
      if (!watchedWallets.includes(transfer.toUserAccount)) continue;

      const { mint, tokenAmount: rawAmount, decimals } = transfer;
      const amount = parseFloat(rawAmount); // UI amount; adjust if raw needed

      // Fetch total supply
      const supply = await getTokenSupply(mint);
      if (!supply) continue;

      const totalSupply = supply.uiAmount;
      const percentage = (amount / totalSupply) * 100;

      if (percentage >= 0.2) {
        await sendTelegramAlert({
          wallet: transfer.toUserAccount,
          mint,
          amount,
          percentage: percentage.toFixed(4),
          txSignature: tx.signature,
          from: transfer.fromUserAccount
        });
      }
    }
  }

  return res.status(200).json({ message: 'Webhook processed' });
};

// Helper: Get token supply via Helius RPC
async function getTokenSupply(mint) {
  const { default: fetch } = await import('node-fetch');  // <-- Add this too, for the helper
  try {
    const response = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenSupply',
          params: [mint]
        })
      }
    );
    const { result } = await response.json();
    return result?.value;
  } catch (e) {
    console.error('Supply fetch error:', e);
    return null;
  }
}

// Helper: Send Telegram message
async function sendTelegramAlert(details) {
  const { default: fetch } = await import('node-fetch');  // <-- Add this too
  const message = `
🚨 *Insider Alert: Large Memecoin Transfer*
*Wallet:* \`${details.wallet}\`
*MINT:* \`${details.mint}\`
*Amount:* ${details.amount.toLocaleString()} tokens
*Percentage:* ${details.percentage}%
*From:* \`${details.from}\`
*TX:* [View on Explorer](https://explorer.solana.com/tx/${details.txSignature})
  `;

  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    console.log('Alert sent for', details.mint);
  } catch (e) {
    console.error('Telegram error:', e);
  }
}
