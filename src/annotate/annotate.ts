// Annotate Local & Clipboard Image
// Loads an image from disk, drag-drop, or clipboard paste, then opens the editor

const ANNOTATE_STORAGE_KEY = 'snapmonk_annotate_image';

const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const errorEl = document.getElementById('an-error') as HTMLElement;

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  setTimeout(() => errorEl.classList.add('hidden'), 4000);
}

async function openImageInEditor(dataUrl: string) {
  await chrome.storage.local.set({ [ANNOTATE_STORAGE_KEY]: dataUrl });
  window.location.href = chrome.runtime.getURL(`src/editor/editor.html?source=annotate`);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Not an image file')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Click to open file picker
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await openImageInEditor(dataUrl);
  } catch (e) {
    showError('Could not read file: ' + (e as Error).message);
  }
});

// Drag and drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await openImageInEditor(dataUrl);
  } catch (e) {
    showError('Could not read file: ' + (e as Error).message);
  }
});

// Paste from clipboard
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await openImageInEditor(dataUrl);
      } catch (err) {
        showError('Could not read clipboard image');
      }
      return;
    }
  }
  showError('No image found in clipboard. Copy an image first.');
});
