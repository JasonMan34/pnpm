import logger, {LoggedPkg} from 'pnpm-logger'
import fs = require('mz/fs')
import {Stats} from 'fs'
import path = require('path')
import rimraf = require('rimraf-then')
import resolve, {Resolution, PackageSpec} from '../resolve'
import mkdirp from '../fs/mkdirp'
import readPkg from '../fs/readPkg'
import exists = require('exists-file')
import memoize, {MemoizedFunc} from '../memoize'
import {Package} from '../types'
import {Got} from '../network/got'
import {InstallContext} from '../api/install'
import fetchResolution from './fetchResolution'
import logStatus from '../logging/logInstallStatus'
import {PackageMeta} from '../resolve/utils/loadPackageMeta'
import dirsum from '../fs/dirsum'
import untouched from '../pkgIsUntouched'

export type FetchedPackage = {
  fetchingPkg: Promise<Package>,
  fetchingFiles: Promise<Boolean>,
  path: string,
  srcPath?: string,
  id: string,
  abort(): Promise<void>,
}

export default async function fetch (
  ctx: InstallContext,
  spec: PackageSpec,
  options: {
    linkLocal: boolean,
    force: boolean,
    root: string,
    storePath: string,
    metaCache: Map<string, PackageMeta>,
    tag: string,
    got: Got,
    update?: boolean,
    shrinkwrapResolution?: Resolution,
    pkgId?: string,
  }
): Promise<FetchedPackage> {
  logger.debug('installing ' + spec.raw)

  const loggedPkg: LoggedPkg = {
    rawSpec: spec.rawSpec,
    name: spec.name,
  }

  try {
    let fetchingPkg = null
    let resolution = options.shrinkwrapResolution
    let pkgId = options.pkgId
    if (!resolution || options.update) {
      const resolveResult = await resolve(spec, {
        loggedPkg,
        root: options.root,
        got: options.got,
        tag: options.tag,
        storePath: options.storePath,
        metaCache: options.metaCache,
      })
      // keep the shrinkwrap resolution when possible
      // to keep the original shasum
      if (pkgId !== resolveResult.id || !resolution) {
        resolution = resolveResult.resolution
      }
      pkgId = resolveResult.id
      if (resolveResult.package) {
        fetchingPkg = Promise.resolve(resolveResult.package)
      }
      ctx.shrinkwrap.packages[resolveResult.id] = {resolution}
    }

    const id = <string>pkgId

    const target = path.join(options.storePath, id)

    const fetchingFiles = ctx.fetchingLocker(id, () => fetchToStore({
      target,
      resolution: <Resolution>resolution,
      loggedPkg,
      got: options.got,
      linkLocal: options.linkLocal,
    }))

    if (fetchingPkg == null) {
      fetchingPkg = fetchingFiles.then(() => readPkg(target))
    }

    return {
      fetchingPkg,
      fetchingFiles,
      id,
      path: target,
      srcPath: resolution.type == 'directory'
        ? resolution.root
        : undefined,
      abort: async () => {
        try {
          await fetchingFiles
        } finally {
          return rimraf(target)
        }
      },
    }
  } catch (err) {
    logStatus({status: 'error', pkg: loggedPkg})
    throw err
  }
}

async function fetchToStore (opts: {
  target: string,
  resolution: Resolution,
  loggedPkg: LoggedPkg,
  got: Got,
  linkLocal: boolean,
}): Promise<Boolean> {
  const target = opts.target
  const targetExists = await exists(target)

  if (targetExists) {
    // if target exists and it wasn't modified, then no need to refetch it
    if (await untouched(target)) return false
    logger.warn(`Refetching ${target} to store, as it was modified`)
  }

  // We fetch into targetStage directory first and then fs.rename() it to the
  // target directory.

  const targetStage = `${target}_stage`

  await rimraf(targetStage)
  if (targetExists) {
    await rimraf(target)
  }

  logStatus({status: 'download-queued', pkg: opts.loggedPkg})
  await fetchResolution(opts.resolution, targetStage, {
    got: opts.got,
    loggedPkg: opts.loggedPkg,
    linkLocal: opts.linkLocal,
  })

  // fs.rename(oldPath, newPath) is an atomic operation, so we do it at the
  // end
  await fs.rename(targetStage, target)

  createShasum(target)

  return true
}

async function createShasum(dirPath: string) {
  try {
    const shasum = await dirsum(dirPath)
    await fs.writeFile(`${dirPath}_shasum`, shasum, 'utf8')
  } catch (err) {
    logger.error({
      message: `Failed to calculate shasum for ${dirPath}`,
      err,
    })
  }
}
