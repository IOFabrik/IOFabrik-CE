import { memo, type JSX, type ReactNode } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../../context';
import { ICON_SIZES } from '../../../shared/constants';
import { Badge } from '../../../shared/ui';

interface AccountFeatureGateProps {
  title: string;
  description: string;
  children: ReactNode;
  lockedMessage?: string;
  readyMessage?: string;
}

function AccountFeatureGate({
  title,
  description,
  children,
  lockedMessage = 'Sign in from Profile when you want to use this cloud-backed feature.',
  readyMessage = 'This device is signed in and ready when this feature becomes available.',
}: AccountFeatureGateProps): JSX.Element {
  const { isAuthenticated, isAuthAvailable } = useAuth();

  return (
    <section className="bg-theme-surface rounded-lg p-6 border border-theme-default">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-theme-primary font-medium">{title}</h3>
            <Badge variant="outline" className="border-blue-500/40 text-blue-400">
              Account scoped
            </Badge>
          </div>
          <p className="text-sm text-theme-muted mt-1">{description}</p>
        </div>
      </div>

      {isAuthenticated ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <ShieldCheck size={ICON_SIZES.md} className="text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-theme-primary">Account connected</p>
            <p className="text-sm text-theme-muted mt-1">{readyMessage}</p>
          </div>
        </div>
      ) : (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-start gap-3">
            <Lock size={ICON_SIZES.md} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-theme-primary">
                {isAuthAvailable ? 'IOFabrik account required' : 'Account sign-in unavailable in this build'}
              </p>
              <p className="text-sm text-theme-muted mt-1">
                {isAuthAvailable
                  ? lockedMessage
                  : 'This build still supports local Git workflows, but account-backed features stay unavailable until sign-in support is enabled.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className={isAuthenticated ? 'space-y-3' : 'space-y-3 opacity-60 pointer-events-none'}>
        {children}
      </div>
    </section>
  );
}

export default memo(AccountFeatureGate);