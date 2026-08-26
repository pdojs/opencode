import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

// A remote-agent binding is represented as a synthetic sentinel workspace ID
// (`remote:<serverID>:<orchestratorID>`, see SessionRunnerRemote.remoteWorkspaceID
// in @opencode-ai/core) rather than a real persisted "wrk_"-prefixed workspace row.
// This field is the shared carrier for both, so the check accepts either prefix.
const isWorkspaceOrRemoteID = Schema.makeFilter<string>(
  (s) => s.startsWith("wrk") || s.startsWith("remote:"),
  { expected: `a string starting with "wrk" or "remote:"` },
)

export const WorkspaceID = Schema.String.check(isWorkspaceOrRemoteID).pipe(
  Schema.brand("WorkspaceV2.ID"),
  statics((schema) => {
    const create = () => schema.make("wrk_" + ascending())
    return {
      ascending: (id?: string) => {
        if (!id) return create()
        if (!id.startsWith("wrk")) throw new Error(`ID ${id} does not start with wrk`)
        return schema.make(id)
      },
      create,
    }
  }),
)
export type WorkspaceID = typeof WorkspaceID.Type
