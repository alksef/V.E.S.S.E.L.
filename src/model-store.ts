export interface SavedModel {
  name: string;
  data: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vessel-model", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("models");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Model storage is busy. Close other VESSEL windows and retry."));
  });
}

export async function readSavedModel(): Promise<SavedModel | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise<SavedModel | undefined>((resolve, reject) => {
      const transaction = database.transaction("models", "readonly");
      const request = transaction.objectStore("models").get("selected");
      transaction.oncomplete = () => resolve(request.result as SavedModel | undefined);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function saveModel(model: SavedModel): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("models", "readwrite");
      transaction.objectStore("models").put(model, "selected");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
