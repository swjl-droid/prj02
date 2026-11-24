// Health check: proves a Vercel function runs, and in which region (ADR-02: sin1).
export function GET() {
  return Response.json({
    ok: true,
    app: 'prj02',
    region: process.env.VERCEL_REGION ?? 'local',
    at: new Date().toISOString(),
  });
}
