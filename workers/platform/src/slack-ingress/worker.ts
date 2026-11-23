import {
  handleSlackIngress,
  type SlackIngressEnv,
} from "@purin-labs/surface-slack/server/slack-ingress/handler";

/**
 * The Slack ingress Worker. Slack sends its events to this Worker. See
 * {@link handleSlackIngress} for what it completes and what it passes on.
 */
export default {
  fetch(
    request: Request,
    env: SlackIngressEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleSlackIngress(request, env, ctx);
  },
} satisfies ExportedHandler<SlackIngressEnv>;
