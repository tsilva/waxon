"use client";

import {
  useEffect,
  useState,
  type ComponentType,
} from "react";

type AuthenticatedClientHydratorProps<TProps extends object> = {
  componentProps: TProps;
  loadClient: () => Promise<ComponentType<TProps>>;
  staticSelector: string;
};

type AuthenticatedClientHydratorConfig<TProps extends object> = Omit<
  AuthenticatedClientHydratorProps<TProps>,
  "componentProps"
>;

export function AuthenticatedClientHydrator<TProps extends object>({
  componentProps,
  loadClient,
  staticSelector,
}: AuthenticatedClientHydratorProps<TProps>) {
  const [ClientComponent, setClientComponent] =
    useState<ComponentType<TProps> | null>(null);
  const [hydrationProps] = useState<TProps>(componentProps);

  useEffect(() => {
    let isCancelled = false;

    if (ClientComponent) {
      return () => {
        isCancelled = true;
      };
    }

    void loadClient().then((LoadedClient) => {
      if (isCancelled) {
        return;
      }

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

  if (!ClientComponent) {
    return null;
  }

  return (
    <>
      <style>{`${staticSelector}{display:none}`}</style>
      <ClientComponent {...hydrationProps} />
    </>
  );
}

export function createAuthenticatedClientHydrator<TProps extends object>({
  loadClient,
  staticSelector,
}: AuthenticatedClientHydratorConfig<TProps>) {
  return function Hydrator(componentProps: TProps) {
    return (
      <AuthenticatedClientHydrator
        componentProps={componentProps}
        loadClient={loadClient}
        staticSelector={staticSelector}
      />
    );
  };
}
