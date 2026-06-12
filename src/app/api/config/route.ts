export async function GET() {
  return Response.json({
    lanHost: process.env.BOOMER_DROP_PUBLIC_HOST?.trim() || null,
  });
}
