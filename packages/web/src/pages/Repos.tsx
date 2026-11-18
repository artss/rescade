import { useRepos } from "../queries.js";
import { ErrorBox } from "../components/ErrorBox.js";
import { GroupedList } from "../components/Group.js";
import { Loading } from "../components/Loading.js";
import { RepoCard, StaleLocksNote } from "../components/RepoCard.js";

export function ReposPage() {
  const { data, error } = useRepos();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-3">
      <GroupedList list="repos" items={data} groupOf={(r) => r.group} keyOf={(r) => r.name} render={(r) => <RepoCard repo={r} />} />
      <StaleLocksNote repos={data} />
    </div>
  );
}
