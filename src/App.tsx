import { useEffect, useState, useCallback } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import "./App.css";

const client = generateClient<Schema>();

// ── Types ──────────────────────────────────────────────────────────────────
type SensorReading = Schema["SensorReading"]["type"];
type Alert = Schema["Alert"]["type"];
type SMHISnapshot = Schema["SMHISnapshot"]["type"];

// ── Demo data (used when no real readings exist yet) ───────────────────────
function generateDemoReadings(): SensorReading[] {
  const now = Date.now();
  return Array.from({ length: 24 }, (_, i) => {
    const ts = new Date(now - (23 - i) * 3600_000).toISOString();
    const hour = new Date(ts).getHours();
    return {
      id: `demo-${i}`,
      deviceId: "greenhouse-01",
      timestamp: ts,
      temperature: parseFloat((22 + 5 * Math.sin((hour / 24) * Math.PI) + (Math.random() - 0.5)).toFixed(1)),
      humidity:    parseFloat((65 - 10 * Math.sin((hour / 24) * Math.PI) + (Math.random() - 0.5) * 2).toFixed(1)),
      soilMoisture: parseFloat((55 + (Math.random() - 0.5) * 4).toFixed(1)),
      lightLevel:  parseFloat((Math.max(0, 800 * Math.sin(((hour - 6) / 12) * Math.PI)) + Math.random() * 10).toFixed(0)),
      vpd: parseFloat((0.5 + Math.random() * 0.3).toFixed(2)),
      createdAt: ts,
      updatedAt: ts,
      owner: "demo",
    } as SensorReading;
  });
}

const DEMO_SMHI: SMHISnapshot = {
  id: "smhi-demo",
  timestamp: new Date().toISOString(),
  location: "Stockholm",
  outdoorTemp: 14.3,
  outdoorHumidity: 78,
  precipitation: 0.2,
  windSpeed: 5.1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  owner: "demo",
};

// ── Helper ─────────────────────────────────────────────────────────────────
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

// ── Sensor card ────────────────────────────────────────────────────────────
function MetricCard({ label, value, unit, icon, color, warning }: {
  label: string; value: number | null; unit: string; icon: string; color: string; warning?: boolean;
}) {
  return (
    <div className={`metric-card ${warning ? "metric-card--warn" : ""}`} style={{ borderTopColor: color }}>
      <span className="metric-icon">{icon}</span>
      <div className="metric-body">
        <span className="metric-label">{label}</span>
        <span className="metric-value" style={{ color }}>
          {value !== null ? value.toFixed(1) : "—"}
          <span className="metric-unit">{unit}</span>
        </span>
      </div>
      {warning && <span className="metric-badge">⚠</span>}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const { user, signOut } = useAuthenticator();
  const [readings, setReadings]   = useState<SensorReading[]>([]);
  const [alerts, setAlerts]       = useState<Alert[]>([]);
  const [smhi, setSmhi]           = useState<SMHISnapshot | null>(null);
  const [demoMode, setDemoMode]   = useState(false);
  const [activeChart, setActiveChart] = useState<"temperature" | "humidity" | "soilMoisture" | "lightLevel">("temperature");

  // ── Subscribe to live data ───────────────────────────────────────────────
  useEffect(() => {
    const sub = client.models.SensorReading.observeQuery({
      filter: { deviceId: { eq: "greenhouse-01" } },
    }).subscribe({
      next: ({ items }) => {
        if (items.length === 0) {
          setDemoMode(true);
          setReadings(generateDemoReadings());
        } else {
          setDemoMode(false);
          const sorted = [...items].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          setReadings(sorted.slice(-48));
        }
      },
      error: () => {
        setDemoMode(true);
        setReadings(generateDemoReadings());
      },
    });
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    const sub = client.models.Alert.observeQuery({
      filter: { resolved: { eq: false } },
    }).subscribe({
      next: ({ items }) => setAlerts(items),
      error: () => setAlerts([]),
    });
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    client.models.SMHISnapshot.list({ limit: 1 })
      .then(({ data }) => setSmhi(data[0] ?? (demoMode ? DEMO_SMHI : null)))
      .catch(() => setSmhi(DEMO_SMHI));
  }, [demoMode]);

  const resolveAlert = useCallback(async (id: string) => {
    await client.models.Alert.update({ id, resolved: true });
  }, []);

  // ── Latest reading ────────────────────────────────────────────────────────
  const latest = readings[readings.length - 1];
  const chartData = readings.map((r) => ({
    time: formatTime(r.timestamp),
    temperature: r.temperature,
    humidity: r.humidity,
    soilMoisture: r.soilMoisture,
    lightLevel: r.lightLevel,
  }));

  const chartMeta: Record<string, { label: string; color: string; unit: string }> = {
    temperature:  { label: "Temperatur",    color: "#ef4444", unit: "°C" },
    humidity:     { label: "Luftfuktighet", color: "#3b82f6", unit: "%" },
    soilMoisture: { label: "Jordfukt",      color: "#22c55e", unit: "%" },
    lightLevel:   { label: "Ljusnivå",      color: "#eab308", unit: " lux" },
  };

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="dashboard-header">
        <div className="header-brand">
          <span className="header-icon">🌿</span>
          <div>
            <h1>Smart Greenhouse Monitor</h1>
            <span className="header-sub">
              Device: greenhouse-01 &nbsp;•&nbsp; {user?.signInDetails?.loginId}
            </span>
          </div>
        </div>
        <div className="header-right">
          {demoMode && <span className="demo-badge">DEMO-LÄGE</span>}
          {latest && (
            <span className="last-updated">
              Senast: {formatTime(latest.timestamp)}
            </span>
          )}
          <button className="btn-signout" onClick={signOut}>Logga ut</button>
        </div>
      </header>

      <main className="dashboard-main">
        {/* ── Metric cards ── */}
        <section className="metric-grid">
          <MetricCard label="Temperatur"    value={latest?.temperature  ?? null} unit="°C"   icon="🌡️" color="#ef4444" warning={(latest?.temperature ?? 0) > 30} />
          <MetricCard label="Luftfuktighet" value={latest?.humidity     ?? null} unit="%"    icon="💧" color="#3b82f6" warning={(latest?.humidity ?? 0) > 90} />
          <MetricCard label="Jordfukt"      value={latest?.soilMoisture ?? null} unit="%"    icon="🪴" color="#22c55e" warning={(latest?.soilMoisture ?? 100) < 30} />
          <MetricCard label="Ljusnivå"      value={latest?.lightLevel   ?? null} unit=" lux" icon="☀️" color="#eab308" warning={(latest?.lightLevel ?? 1000) < 50} />
        </section>

        <div className="dashboard-body">
          {/* ── Chart ── */}
          <section className="chart-panel">
            <div className="chart-tabs">
              {(Object.keys(chartMeta) as (keyof typeof chartMeta)[]).map((k) => (
                <button
                  key={k}
                  className={`chart-tab ${activeChart === k ? "chart-tab--active" : ""}`}
                  style={activeChart === k ? { borderBottomColor: chartMeta[k].color, color: chartMeta[k].color } : {}}
                  onClick={() => setActiveChart(k as typeof activeChart)}
                >
                  {chartMeta[k].label}
                </button>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                <XAxis dataKey="time" tick={{ fill: "#a0aec0", fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fill: "#a0aec0", fontSize: 11 }} unit={chartMeta[activeChart].unit} width={52} />
                <Tooltip
                  contentStyle={{ background: "#1a202c", border: "1px solid #4a5568", borderRadius: 8 }}
                  labelStyle={{ color: "#e2e8f0" }}
                />
                <Legend wrapperStyle={{ color: "#a0aec0" }} />
                <Line
                  type="monotone"
                  dataKey={activeChart}
                  stroke={chartMeta[activeChart].color}
                  name={chartMeta[activeChart].label}
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </section>

          <div className="side-panels">
            {/* ── SMHI Outdoor Weather ── */}
            <section className="smhi-panel">
              <h2>🌦 Utomhusväder (SMHI)</h2>
              {smhi ? (
                <div className="smhi-grid">
                  <div className="smhi-item"><span>Plats</span><strong>{smhi.location}</strong></div>
                  <div className="smhi-item"><span>Temp ute</span><strong>{smhi.outdoorTemp?.toFixed(1)} °C</strong></div>
                  <div className="smhi-item"><span>Luftfukt</span><strong>{smhi.outdoorHumidity?.toFixed(0)} %</strong></div>
                  <div className="smhi-item"><span>Vind</span><strong>{smhi.windSpeed?.toFixed(1)} m/s</strong></div>
                  <div className="smhi-item"><span>Nederbörд</span><strong>{smhi.precipitation?.toFixed(1)} mm</strong></div>
                  {latest && (
                    <div className="smhi-item smhi-diff">
                      <span>Δ Temp (inne−ute)</span>
                      <strong style={{ color: "#f6ad55" }}>
                        {(latest.temperature - (smhi.outdoorTemp ?? 0)).toFixed(1)} °C
                      </strong>
                    </div>
                  )}
                </div>
              ) : (
                <p className="no-data">Hämtar SMHI-data…</p>
              )}
            </section>

            {/* ── Alerts ── */}
            <section className="alerts-panel">
              <h2>🔔 Aktiva Larm ({alerts.filter((a) => !a.resolved).length})</h2>
              {alerts.length === 0 ? (
                <p className="no-alerts">✅ Inga aktiva larm</p>
              ) : (
                <ul className="alert-list">
                  {alerts.filter((a) => !a.resolved).map((al) => (
                    <li key={al.id} className="alert-item">
                      <div className="alert-info">
                        <span className="alert-type">{al.alertType}</span>
                        <span className="alert-detail">
                          Värde: {al.value?.toFixed(1)} | Tröskel: {al.threshold?.toFixed(1)}
                        </span>
                        <span className="alert-time">{formatTime(al.timestamp)}</span>
                      </div>
                      <button className="btn-resolve" onClick={() => resolveAlert(al.id)}>
                        Kvittera
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        {/* ── VPD Info ── */}
        {latest?.vpd != null && (
          <section className="vpd-panel">
            <h2>Ångrycktsdifferens (VPD)</h2>
            <div className="vpd-bar-wrap">
              <div className="vpd-bar" style={{ width: `${Math.min((latest.vpd / 2) * 100, 100)}%`,
                background: latest.vpd < 0.4 ? "#3b82f6" : latest.vpd < 0.8 ? "#22c55e" : latest.vpd < 1.2 ? "#eab308" : "#ef4444" }} />
            </div>
            <p className="vpd-value">
              {latest.vpd.toFixed(2)} kPa &nbsp;—&nbsp;
              {latest.vpd < 0.4 ? "🔵 För hög luftfuktighet" :
               latest.vpd < 0.8 ? "🟢 Optimal zon" :
               latest.vpd < 1.2 ? "🟡 Lätt stress" : "🔴 Hög värmestress"}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
