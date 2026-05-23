// Slack Web API integration — uses the new external upload API (not deprecated files.upload)

/** Upload a screenshot to Slack and share it to a channel. */
export async function uploadToSlack(
  token: string,
  channelId: string,
  blob: Blob,
  message: string,
): Promise<string> {
  const filename = `snapmonk-${Date.now()}.png`;

  // Step 1: Get an upload URL
  const urlRes = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${blob.size}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const urlData = (await urlRes.json()) as {
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };
  if (!urlData.ok) throw new Error(`Slack: ${urlData.error ?? 'getUploadURLExternal failed'}`);

  const { upload_url, file_id } = urlData as { upload_url: string; file_id: string };

  // Step 2: Upload the PNG binary to the signed URL
  const uploadRes = await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
  if (!uploadRes.ok) throw new Error(`Slack upload failed: ${uploadRes.status}`);

  // Step 3: Complete the upload and post to the channel
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: file_id, title: `SnapMonk Screenshot — ${new Date().toLocaleString()}` }],
      channel_id: channelId,
      initial_comment: message || '📸 Screenshot captured with SnapMonk by DevOps-Monk',
    }),
  });
  const completeData = (await completeRes.json()) as {
    ok: boolean;
    error?: string;
    files?: Array<{ permalink?: string }>;
  };
  if (!completeData.ok) throw new Error(`Slack: ${completeData.error ?? 'completeUpload failed'}`);

  return completeData.files?.[0]?.permalink ?? `https://slack.com/files`;
}

/** Look up a channel by name (e.g. "#bugs") and return its ID. */
export async function resolveChannelId(token: string, nameOrId: string): Promise<string> {
  // If it already looks like an ID (starts with C), return as-is
  if (/^[A-Z0-9]{8,}$/i.test(nameOrId)) return nameOrId;

  const clean = nameOrId.replace(/^#/, '').toLowerCase();
  const res = await fetch(
    `https://slack.com/api/conversations.list?exclude_archived=true&types=public_channel,private_channel&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    channels?: Array<{ id: string; name: string }>;
  };
  if (!data.ok) throw new Error(`Slack: ${data.error ?? 'conversations.list failed'}`);

  const channel = data.channels?.find((c) => c.name === clean);
  if (!channel) throw new Error(`Slack: channel "#${clean}" not found`);
  return channel.id;
}

/** Validate a Slack bot token by calling auth.test. */
export async function validateSlack(token: string): Promise<string> {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { ok: boolean; error?: string; user?: string };
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return data.user ?? 'Bot';
}
