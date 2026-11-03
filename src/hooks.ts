import { Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { getCachedInstalls, setCachedInstalls } from "./storage";
import { StudioProInstall, listStudioProInstalls } from "./studiopro";

/** Installed Studio Pro versions: the saved list at once, rescanned in the background; undefined until either is known. */
export function useStudioProInstalls(refreshId: number) {
  const [installs, setInstalls] = useState<StudioProInstall[] | undefined>(() => getCachedInstalls()?.items);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void listStudioProInstalls().then((found) => {
      setCachedInstalls(found);
      if (mounted) setInstalls(found);
    // On failure keep the saved list, like the branch cache.
    }).catch((e) => {
      if (mounted) setInstalls((saved) => saved ?? []);
      void showToast({ style: Toast.Style.Failure, title: "Could not list Studio Pro versions", message: String(e) });
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [refreshId]);
  return { installs, loading };
}
