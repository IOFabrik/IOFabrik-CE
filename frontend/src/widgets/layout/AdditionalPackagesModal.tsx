import { memo } from 'react';
import { DownloadCloud, Loader2 } from 'lucide-react';
import { ICON_SIZES } from '../../shared/constants';
import { useRepo } from '../../context';
import {
  BlockingDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Progress,
} from '../../shared/ui';

function AdditionalPackagesModal(): JSX.Element {
  const {
    isInstallingPackages,
    packagesInstallMessage,
    packagesInstallPercent,
  } = useRepo();

  return (
    <BlockingDialog open={isInstallingPackages}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DownloadCloud size={ICON_SIZES.sm} className="text-blue-400" />
            Preparing required packages
          </DialogTitle>
          <DialogDescription>
            Checking the supporting tools included with IOFabrik.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          <div className="flex items-center gap-2 text-theme-secondary text-sm">
            <Loader2 size={14} className="animate-spin" />
            <span>{packagesInstallMessage || 'Checking supporting tools...'}</span>
          </div>

          {packagesInstallPercent != null && (
            <div className="space-y-1">
              <Progress value={packagesInstallPercent} />
              <p className="text-[11px] text-theme-muted text-right">
                {Math.round(packagesInstallPercent)}%
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </BlockingDialog>
  );
}

export default memo(AdditionalPackagesModal);
