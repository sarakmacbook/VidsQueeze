import { getJob } from "@/lib/queue";
import { readableStreamFromFile } from "@/lib/telegram";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(Number(id));
  if (!job || !job.outputPath) return new Response("Not found", { status: 404 });
  try {
    await fs.access(job.outputPath);
  } catch {
    return new Response("Output file was cleaned up – run the job again", { status: 410 });
  }
  const stat = await fs.stat(job.outputPath);
  const fileName = `${path.basename(job.outputPath)}`;
  const webStream = readableStreamFromFile(job.outputPath);
  return new Response(webStream, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}
