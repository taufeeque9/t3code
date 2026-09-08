/**
 * Client state for the fuzzy sidebar search.
 *
 * Parallel to `threadSearch`, which backs the command palette's exact substring
 * scan. This one carries a per-environment project scope, because a sidebar
 * project group can span several environments and each names the project by its
 * own id.
 *
 * @module threadUnitSearch
 */
import {
  EnvironmentId,
  ProjectId,
  OrchestrationSearchThreadUnitsInput,
  type OrchestrationSearchThreadUnitsResult,
  type OrchestrationThreadSearchUnitMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface EnvironmentThreadUnitSearchMatch extends OrchestrationThreadSearchUnitMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadUnitSearchState {
  readonly matches: ReadonlyArray<EnvironmentThreadUnitSearchMatch>;
  readonly isLoading: boolean;
}

/** One environment to search, with the project to narrow it to when scoped. */
const SearchTarget = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
});
export type ThreadUnitSearchTarget = typeof SearchTarget.Type;

const SearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(SearchTarget), OrchestrationSearchThreadUnitsInput.fields.query]),
);
const decodeSearchKey = Schema.decodeUnknownOption(SearchKey);

export function makeThreadUnitSearchKey(
  targets: ReadonlyArray<ThreadUnitSearchTarget>,
  query: string,
): string {
  const sorted = [...targets].sort(
    (left, right) =>
      left.environmentId.localeCompare(right.environmentId) ||
      (left.projectId ?? "").localeCompare(right.projectId ?? ""),
  );
  return JSON.stringify([sorted, query]);
}

/**
 * Combines one query atom per target. A failed or disconnected environment
 * contributes nothing rather than failing the whole search, so the sidebar's
 * local title match stays usable.
 */
export function createThreadUnitSearchAtomFamily<E>(options: {
  readonly getSearchAtom: (
    target: ThreadUnitSearchTarget,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadUnitsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadUnitSearchState => {
      const parsedKey = decodeSearchKey(key);
      if (Option.isNone(parsedKey)) return { matches: [], isLoading: false };

      const [targets, query] = parsedKey.value;
      const matches: EnvironmentThreadUnitSearchMatch[] = [];
      let isLoading = false;
      for (const target of targets) {
        const result = get(options.getSearchAtom(target, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null) continue;
        matches.push(
          ...value.matches.map((match) => ({ ...match, environmentId: target.environmentId })),
        );
      }
      // Environments are searched independently, so their scores only become
      // comparable once merged.
      matches.sort((left, right) => right.score - left.score);
      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}
