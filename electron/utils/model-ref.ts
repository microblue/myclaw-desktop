/**
 * Model reference helpers.
 *
 * openclaw identifies models as `<provider-key>/<model-id>` strings.
 * Multiple places in MyClaw construct or deconstruct these refs and
 * previously re-implemented the prefix / strip logic inline — divergence
 * risk if openclaw ever changes the separator or prefix rules.
 *
 * One central definition lives here; every caller imports these.
 * If openclaw shifts to `<provider>:<model>` or `<provider>@<model>`
 * the entire codebase updates with one edit.
 */

/**
 * Return `<provider>/<model>` if `modelId` isn't already prefixed;
 * otherwise return it unchanged.
 */
export function prefix_model_ref(provider_key: string, model_id: string): string {
  return model_id.startsWith(`${provider_key}/`) ? model_id : `${provider_key}/${model_id}`;
}

/**
 * Return the model id with the `<provider>/` prefix removed.
 * If `ref` isn't prefixed with the given provider, returns it unchanged.
 */
export function strip_model_ref(provider_key: string, ref: string): string {
  return ref.startsWith(`${provider_key}/`) ? ref.slice(provider_key.length + 1) : ref;
}
