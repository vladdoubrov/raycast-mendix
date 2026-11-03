/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Default Clone Type - Full history uses a reusable local cache. Partial downloads historical file contents on demand and needs network access for some operations. */
  "cloneType": "full" | "partial",
  /** Reuse Local Repositories - Seed from a compatible local checkout when possible; existing project files are never modified. */
  "reuseLocalRepositories": boolean,
  /** Repository Cache Root (optional) - Defaults to .mendix-switcher-cache in the app's projects root. Prefer the same volume as checkouts for hard-link reuse. */
  "repositoryCacheRoot"?: string,
  /** Detailed Clone Diagnostics - Off by default. Logs can contain repository paths and branch names; review them before sharing. */
  "detailedCloneDiagnostics": boolean,
  /** Mendix Personal Access Token - PAT with mx:modelrepository:repo:read. Sent only to repository.api.mendix.com as Authorization: MxToken. */
  "personalAccessToken"?: string,
  /** Local Projects Root - A parent folder containing your local Studio Pro checkouts; example C:\Mendix. */
  "projectsRoot"?: string,
  /** Studio Pro Executable (optional) - Opens local and freshly cloned MPRs with this studiopro.exe; also used for the assisted download. */
  "studioProExecutable"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `switch` command */
  export type Switch = ExtensionPreferences & {}
  /** Preferences accessible in the `manage-apps` command */
  export type ManageApps = ExtensionPreferences & {}
  /** Preferences accessible in the `versions` command */
  export type Versions = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `switch` command */
  export type Switch = {}
  /** Arguments passed to the `manage-apps` command */
  export type ManageApps = {}
  /** Arguments passed to the `versions` command */
  export type Versions = {}
}

