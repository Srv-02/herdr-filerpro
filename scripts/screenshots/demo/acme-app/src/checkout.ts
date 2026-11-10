export async function addToCart(sku: string, qty = 1) {
  const res = await fetch("/api/cart", { method: "POST", body: JSON.stringify({ sku, qty }) });
  if (!res.ok) throw new Error(`cart failed: ${res.status}`);
  return res.json();
}
