import { Storage } from "megajs";

export function megaConfigured() {
  return Boolean(process.env.MEGA_EMAIL?.trim() && process.env.MEGA_PASSWORD);
}

export async function upload(data, fileName) {
  const email = process.env.MEGA_EMAIL?.trim();
  const password = process.env.MEGA_PASSWORD;
  if (!email || !password) {
    throw new Error("MEGA_EMAIL and MEGA_PASSWORD must be configured in the server environment.");
  }

  const storage = new Storage({ email, password, keepalive: false });
  try {
    await storage.ready;
    const file = await storage.upload({ name: fileName, size: data.byteLength }, data).complete;
    return await file.link();
  } finally {
    storage.close();
  }
}
