import fs from 'node:fs/promises'
import path from 'node:path'

// Local image filenames can be reused after an edit or vault restore. Clear
// optimized variants before replacing their sources so Docker's persistent
// cache cannot keep serving the previous image at the same URL.
export async function clearDockerImageCache(): Promise<void> {
  if (process.env.BLADEVAULT_DOCKER_RUNTIME !== '1') return

  const cacheDir = path.resolve(process.cwd(), '.next', 'cache', 'images')
  let entries
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  // Keep the directory itself: Compose mounts a volume here. Next.js stores
  // variants in hash-named directories; skip symlinks and unrelated entries.
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[\w-]+$/.test(entry.name))
      .map((entry) =>
        fs.rm(path.join(cacheDir, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  )
}
