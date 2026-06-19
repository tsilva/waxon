"use client";

import {
  useEffect,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

type AuthenticatedProvidersComponent = (props: {
  children: ReactNode;
}) => ReactElement;

type AuthenticatedClientHydratorProps<TProps extends object> = {
  componentProps: TProps;
  loadClient: () => Promise<ComponentType<TProps>>;
  staticSelector: string;
};

export function AuthenticatedClientHydrator<TProps extends object>({
  componentProps,
  loadClient,
  staticSelector,
}: AuthenticatedClientHydratorProps<TProps>) {
  const [ClientComponent, setClientComponent] =
    useState<ComponentType<TProps> | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps] = useState<TProps>(componentProps);

  useEffect(() => {
    let isCancelled = false;

    if (ClientComponent) {
      return () => {
        isCancelled = true;
      };
    }

    void Promise.all([
      loadClient(),
      import("@/app/AuthenticatedProviders"),
    ]).then(([LoadedClient, providerModule]) => {
      if (isCancelled) {
        return;
      }

      setAuthenticatedProviders(
        () =>
          providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
      );
      setClientComponent(() => LoadedClient);
    });

    return () => {
      isCancelled = true;
    };
  }, [ClientComponent, loadClient]);

  useEffect(() => {
    if (!ClientComponent) {
      return;
    }

    const staticView = document.querySelector(staticSelector);
    staticView?.setAttribute("inert", "");
  }, [ClientComponent, staticSelector]);

  if (!ClientComponent || !AuthenticatedProviders) {
    return null;
  }

  return (
    <>
      <style>{`${staticSelector}{display:none}`}</style>
      <AuthenticatedProviders>
        <ClientComponent {...hydrationProps} />
      </AuthenticatedProviders>
    </>
  );
}
