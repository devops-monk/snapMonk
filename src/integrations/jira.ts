// Jira Cloud REST API v3 integration

function basicAuth(email: string, token: string): string {
  return `Basic ${btoa(`${email}:${token}`)}`;
}

/** Attach a screenshot PNG to a Jira issue. */
export async function attachToJira(
  baseUrl: string,
  email: string,
  apiToken: string,
  issueKey: string,
  blob: Blob,
): Promise<string> {
  const clean = baseUrl.replace(/\/$/, '');
  const filename = `snapmonk-${Date.now()}.png`;

  const formData = new FormData();
  formData.append('file', blob, filename);

  const res = await fetch(`${clean}/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(email, apiToken),
      'X-Atlassian-Token': 'no-check', // required to bypass CSRF
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as Array<{ self: string; filename: string }>;
  const attachment = data[0];
  // Return URL to the Jira issue page
  return `${clean}/browse/${issueKey}`;
}

/** Add a comment with an inline screenshot reference to a Jira issue. */
export async function commentOnJira(
  baseUrl: string,
  email: string,
  apiToken: string,
  issueKey: string,
  note: string,
  attachmentFilename: string,
): Promise<void> {
  const clean = baseUrl.replace(/\/$/, '');

  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        ...(note
          ? [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: note }],
              },
            ]
          : []),
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: `📸 Screenshot attached: ${attachmentFilename}`,
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Captured with SnapMonk by DevOps-Monk', marks: [{ type: 'em' }] },
          ],
        },
      ],
    },
  };

  const res = await fetch(`${clean}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(email, apiToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira comment ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Validate Jira credentials by fetching the current user. */
export async function validateJira(
  baseUrl: string,
  email: string,
  apiToken: string,
): Promise<string> {
  const clean = baseUrl.replace(/\/$/, '');
  const res = await fetch(`${clean}/rest/api/3/myself`, {
    headers: { Authorization: basicAuth(email, apiToken) },
  });
  if (!res.ok) throw new Error(`Jira auth failed (${res.status})`);
  const data = (await res.json()) as { displayName: string };
  return data.displayName;
}
