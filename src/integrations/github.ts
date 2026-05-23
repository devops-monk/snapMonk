// GitHub REST API v3 integration

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function ghFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `GitHub ${res.status}`);
  return json;
}

/** Upload a screenshot PNG to `.snapmonk/` in the given repo and return its raw URL. */
export async function uploadScreenshot(
  token: string,
  owner: string,
  repo: string,
  blob: Blob,
): Promise<string> {
  const base64 = await blobToBase64(blob);
  const filename = `screenshot-${Date.now()}.png`;
  const path = `.snapmonk/${filename}`;

  const data = (await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add SnapMonk screenshot ${filename}`,
      content: base64,
    }),
  })) as { content: { download_url: string } };

  return data.content.download_url;
}

/** Post a comment on a GitHub issue with the screenshot embedded. */
export async function commentOnIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  imageUrl: string,
  note: string,
): Promise<string> {
  const parts: string[] = [];
  if (note) parts.push(note, '\n\n---\n');
  parts.push(`![SnapMonk Screenshot](${imageUrl})`);
  parts.push('\n\n<sub>Captured with [SnapMonk](https://devops-monk.com) · DevOps-Monk</sub>');

  const data = (await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body: parts.join('') }),
  })) as { html_url: string };

  return data.html_url;
}

/** Validate a GitHub token by fetching the authenticated user. */
export async function validateToken(token: string): Promise<string> {
  const user = (await ghFetch('/user', token)) as { login: string };
  return user.login;
}
