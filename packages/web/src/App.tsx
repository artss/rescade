import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Route, Switch } from "wouter";
import { ApiError } from "./api.js";
import { Layout, type Connection } from "./components/Layout.js";
import { TokenForm } from "./components/TokenForm.js";
import { CascadesPage } from "./pages/Cascades.js";
import { ReposPage } from "./pages/Repos.js";
import { RunPage } from "./pages/Run.js";
import { RunsPage } from "./pages/Runs.js";
import { applyEvent } from "./queries.js";
import { followEvents } from "./sse.js";
import { useAuth } from "./token.js";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // events keep the answers fresh
        staleTime: 30_000,
        // a 4xx will not get better by asking again
        retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
      },
    },
  });
}

export function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <Root />
    </QueryClientProvider>
  );
}

function Root() {
  const { token, rejected } = useAuth();
  const qc = useQueryClient();
  useEffect(() => {
    if (token === null) qc.clear();
  }, [qc, token]);
  return token === null ? <TokenForm rejected={rejected} /> : <SignedIn />;
}

function SignedIn() {
  const connection = useEvents();
  return (
    <Layout connection={connection}>
      <Switch>
        <Route path="/" component={CascadesPage} />
        <Route path="/runs" component={RunsPage} />
        <Route path="/runs/:id">{(p) => <RunPage key={p.id} id={Number(p.id)} />}</Route>
        <Route path="/repos" component={ReposPage} />
        <Route>
          <p className="text-sm text-zinc-500">No such page.</p>
        </Route>
      </Switch>
    </Layout>
  );
}

/** One event stream for the whole app; on every (re)connect the answers are asked for again. */
function useEvents(): Connection {
  const qc = useQueryClient();
  const [connection, setConnection] = useState<Connection>("connecting");
  useEffect(() => {
    const ac = new AbortController();
    void followEvents(
      {
        onEvent: (e) => applyEvent(qc, e),
        onOpen: () => {
          setConnection("live");
          void qc.invalidateQueries();
        },
        onDown: () => setConnection("down"),
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [qc]);
  return connection;
}
