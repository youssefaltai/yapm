import { builder } from "./builder.js";
import "./types.js";
import "./queries.js";
import "./mutations.js";
import "./requests.js";
import "./inbox.js";
import "./push.js";
import "./runs.js";
import "./projects.js";

export type { GraphQLContext } from "./builder.js";

export const schema = builder.toSchema();
