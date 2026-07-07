"use client";

import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { Bell, Database, Download, FileText, Filter, ShieldCheck, UploadCloud } from "lucide-react";

const data = [
  { month: "Jan", sales: 120, forecast: 130, quality: 97 },
  { month: "Feb", sales: 180, forecast: 170, quality: 95 },
  { month: "Mar", sales: 220, forecast: 235, quality: 91 },
  { month: "Apr", sales: 260, forecast: 280, quality: 96 }
];

const records = [
  { name: "Sale A", tenant: "tenant-a", amount: "$1,200", status: "Normal" },
  { name: "Sale B", tenant: "tenant-a", amount: "$2,450", status: "Forecasted" },
  { name: "Sale C", tenant: "tenant-a", amount: "$4,900", status: "Anomaly" }
];

const schema = [
  { column: "date", type: "date", nulls: "0%" },
  { column: "amount", type: "float", nulls: "0%" },
  { column: "segment", type: "string", nulls: "2%" }
];

export default function Page() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <strong>Enterprise AI</strong>
        <nav>
          <a>Dashboard</a>
          <a>Data Import</a>
          <a>Predictions</a>
          <a>AI Query</a>
          <a>Audit</a>
        </nav>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <h1>Analytics Dashboard</h1>
            <p>Tenant-isolated metrics, forecasts, and AI-assisted analysis.</p>
          </div>
          <div className="actions">
            <button title="Upload data"><UploadCloud size={18} /> Import</button>
            <button title="Filter"><Filter size={18} /> Filter</button>
            <button title="Export"><Download size={18} /> Export</button>
          </div>
        </header>

        <section className="metrics">
          <div className="metric"><Database size={18} /><span>Datasets</span><strong>12</strong></div>
          <div className="metric"><ShieldCheck size={18} /><span>Guardrails</span><strong>Active</strong></div>
          <div className="metric"><Bell size={18} /><span>Alerts</span><strong>3</strong></div>
          <div className="metric"><FileText size={18} /><span>Exports</span><strong>PDF/CSV</strong></div>
        </section>

        <section className="grid">
          <div className="panel wide">
            <h2>Sales Trend</h2>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data}>
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="sales" stroke="#0f766e" strokeWidth={3} />
                <Line type="monotone" dataKey="forecast" stroke="#7c3aed" strokeWidth={3} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="panel">
            <h2>Segment Mix</h2>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={[{ name: "SMB", value: 44 }, { name: "Mid", value: 31 }, { name: "Enterprise", value: 25 }]} dataKey="value" outerRadius={90}>
                  {["#0f766e", "#7c3aed", "#f59e0b"].map(color => <Cell key={color} fill={color} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="panel">
            <h2>Monthly Revenue</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data}>
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="sales" fill="#0f766e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="panel">
            <h2>Import Schema Preview</h2>
            <table>
              <thead>
                <tr><th>Column</th><th>Type</th><th>Nulls</th></tr>
              </thead>
              <tbody>
                {schema.map(row => (
                  <tr key={row.column}><td>{row.column}</td><td>{row.type}</td><td>{row.nulls}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h2>Tenant Records</h2>
            <table>
              <thead>
                <tr><th>Name</th><th>Tenant</th><th>Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {records.map(row => (
                  <tr key={row.name}><td>{row.name}</td><td>{row.tenant}</td><td>{row.amount}</td><td>{row.status}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel wide split">
            <div>
              <h2>AI Query Guardrail</h2>
              <dl className="status-list">
                <div><dt>SQL mode</dt><dd>Read-only</dd></div>
                <div><dt>Last block</dt><dd>DROP TABLE attempt</dd></div>
                <div><dt>Token usage</dt><dd>8,420</dd></div>
              </dl>
            </div>
            <div>
              <h2>RAG Sources</h2>
              <dl className="status-list">
                <div><dt>Documents</dt><dd>18</dd></div>
                <div><dt>Citations</dt><dd>Required</dd></div>
                <div><dt>Vector store</dt><dd>Qdrant</dd></div>
              </dl>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
