import { useCallback, useEffect, useState } from "react";
import { api, type Business, type Product } from "../lib/api";
import { Card, SectionTitle, Spinner, ErrorBox, btnPrimary, btnSecondary, inputCls, labelCls } from "../components/ui";

export default function BusinessSettings({ business, onBusinessChanged }: { business: Business; onBusinessChanged: (b: Business) => void }) {
  const [form, setForm] = useState({
    name: "", description: "", hours: "", location: "", returnPolicy: "", tone: "", escalationContact: ""
  });
  const [faqs, setFaqs] = useState<Array<{ q: string; a: string }>>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productForm, setProductForm] = useState({ name: "", price: "", description: "", sku: "" });
  const [csv, setCsv] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [b, p] = await Promise.all([
        api.get<{ business: Business } | Business>(`/api/businesses/${business.id}`),
        api.get<{ products: Product[] } | Product[]>(`/api/businesses/${business.id}/products`)
      ]);
      const biz = (b as { business?: Business }).business ?? (b as Business);
      setForm({
        name: biz.name ?? "", description: biz.description ?? "", hours: biz.hours ?? "",
        location: biz.location ?? "", returnPolicy: biz.returnPolicy ?? "",
        tone: biz.tone ?? "", escalationContact: biz.escalationContact ?? ""
      });
      setFaqs(Array.isArray(biz.faqs) ? biz.faqs : []);
      setProducts(Array.isArray(p) ? p : p.products);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load settings"); }
    finally { setLoading(false); }
  }, [business.id]);

  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const res = await api.put<{ business: Business } | Business>(`/api/businesses/${business.id}`, { ...form, faqs });
      const updated = (res as { business?: Business }).business ?? (res as Business);
      onBusinessChanged({ ...business, ...updated });
      setNotice("Business knowledge base saved. AI drafts will only use facts recorded here - anything missing is flagged for human review instead of invented.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save settings"); }
    finally { setSaving(false); }
  }

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    setAddingProduct(true); setError(""); setNotice("");
    try {
      await api.post(`/api/businesses/${business.id}/products`, {
        name: productForm.name,
        price: productForm.price === "" ? undefined : Number(productForm.price),
        description: productForm.description || undefined,
        sku: productForm.sku || undefined
      });
      setProductForm({ name: "", price: "", description: "", sku: "" });
      setNotice("Product added to the catalog.");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add product"); }
    finally { setAddingProduct(false); }
  }

  async function importCsv(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true); setError(""); setNotice("");
    try {
      const res = await api.post<{ imported?: number; count?: number }>(`/api/businesses/${business.id}/products/import`, { csv });
      setCsv("");
      setNotice(`Catalog import finished${typeof res.imported === "number" ? `: ${res.imported} product(s) imported` : ""}.`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "CSV import failed"); }
    finally { setImporting(false); }
  }

  if (loading) return <Spinner label="Loading business settings..." />;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight">Business Settings</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">The knowledge base the AI Operator is allowed to use. If a price, policy or answer is not recorded here, the AI must ask or flag it for review rather than invent it.</p>
      </div>
      {error && <ErrorBox message={error} />}
      {notice && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</p>}

      <Card>
        <SectionTitle>Knowledge base</SectionTitle>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="b-name">Business name</label>
            <input id="b-name" className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className={labelCls} htmlFor="b-desc">Description</label>
            <textarea id="b-desc" rows={3} className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="b-hours">Hours</label>
              <input id="b-hours" className={inputCls} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="Mon-Sat 9am-6pm" />
            </div>
            <div>
              <label className={labelCls} htmlFor="b-location">Location</label>
              <input id="b-location" className={inputCls} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="b-returns">Return policy</label>
            <textarea id="b-returns" rows={2} className={inputCls} value={form.returnPolicy} onChange={(e) => setForm({ ...form, returnPolicy: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="b-tone">Brand tone</label>
              <input id="b-tone" className={inputCls} value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} placeholder="Warm, concise, helpful" />
            </div>
            <div>
              <label className={labelCls} htmlFor="b-escalation">Escalation contact</label>
              <input id="b-escalation" className={inputCls} value={form.escalationContact} onChange={(e) => setForm({ ...form, escalationContact: e.target.value })} placeholder="owner@business.com" />
            </div>
          </div>

          <div>
            <p className={labelCls}>Frequently asked questions</p>
            <div className="space-y-2">
              {faqs.map((f, i) => (
                <div key={i} className="grid gap-2 rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60 sm:grid-cols-2">
                  <input aria-label={`FAQ ${i + 1} question`} className={inputCls} value={f.q} placeholder="Question"
                    onChange={(e) => setFaqs(faqs.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} />
                  <div className="flex gap-2">
                    <input aria-label={`FAQ ${i + 1} answer`} className={inputCls} value={f.a} placeholder="Answer"
                      onChange={(e) => setFaqs(faqs.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} />
                    <button type="button" className="shrink-0 text-sm font-semibold text-red-600" onClick={() => setFaqs(faqs.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                </div>
              ))}
              <button type="button" className={btnSecondary} onClick={() => setFaqs([...faqs, { q: "", a: "" }])}>Add FAQ</button>
            </div>
          </div>

          <button type="submit" disabled={saving} className={`${btnPrimary} w-full`}>{saving ? "Saving..." : "Save knowledge base"}</button>
        </form>
      </Card>

      <Card>
        <SectionTitle>Product catalog ({products.length})</SectionTitle>
        {products.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No products yet. Add products below or import a CSV - the AI quotes prices only from this catalog.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
                  <th className="py-2 pr-3">Product</th><th className="py-2 pr-3">Price</th><th className="py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2 pr-3 font-medium">{p.name}{p.sku ? <span className="block text-xs text-slate-400">{p.sku}</span> : null}</td>
                    <td className="py-2 pr-3">{p.price === undefined || p.price === null ? "-" : typeof p.price === "number" ? `$${p.price.toFixed(2)}` : p.price}</td>
                    <td className="py-2 text-slate-500 dark:text-slate-400">{p.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={addProduct} className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <p className="text-sm font-bold">Add a product</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="p-name">Name</label>
              <input id="p-name" className={inputCls} required value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-price">Price (USD)</label>
              <input id="p-price" type="number" min="0" step="0.01" className={inputCls} value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-sku">SKU (optional)</label>
              <input id="p-sku" className={inputCls} value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-desc">Description</label>
              <input id="p-desc" className={inputCls} value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} />
            </div>
          </div>
          <button type="submit" disabled={addingProduct} className={btnPrimary}>{addingProduct ? "Adding..." : "Add product"}</button>
        </form>

        <form onSubmit={importCsv} className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <p className="text-sm font-bold">Import catalog from CSV</p>
          <label className={labelCls} htmlFor="p-csv">CSV with header row: name,price,description,sku</label>
          <textarea id="p-csv" rows={5} className={`${inputCls} font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder={"name,price,description,sku\nSoy Candle,24.00,Hand-poured soy candle,HG-CND-01"} />
          <button type="submit" disabled={importing || !csv.trim()} className={btnSecondary}>{importing ? "Importing..." : "Import CSV"}</button>
        </form>
      </Card>
    </div>
  );
}
