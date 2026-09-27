import path from 'node:path'
import { getLocalImagesDirPath } from '@/lib/local-db'

const SAFE_DIRECTORY_SEGMENT = /^[a-z0-9._-]+$/i

export function resolveLocalImagePath(relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid image path')
  }

  const root = path.resolve(getLocalImagesDirPath())
  const resolved = path.resolve(root, relativePath)
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid image path')
  }
  return resolved
}

export function resolveLocalImageDirectory(name: string): string {
  if (name === '.' || name === '..' || !SAFE_DIRECTORY_SEGMENT.test(name)) {
    throw new Error('Invalid image directory')
  }
  return resolveLocalImagePath(name)
}
