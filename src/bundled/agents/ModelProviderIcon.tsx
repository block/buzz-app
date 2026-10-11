import {
  ClaudeLogoIcon,
  OpenAILogoIcon,
  GeminiLogoIcon,
  DeepSeekLogoIcon,
  GrokLogoIcon,
  KimiLogoIcon,
  QwenLogoIcon,
  MetaLogoIcon,
  DatabricksLogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";

/** Catalogs expose names and IDs, so recognize model families before the host. */
export function ModelProviderIcon({
  model,
  provider,
}: {
  model: string;
  provider: string;
}) {
  const name = model.toLowerCase();
  const brand = /deepseek/.test(name)
    ? DeepSeekLogoIcon
    : /grok/.test(name)
      ? GrokLogoIcon
      : /kimi|moonshot/.test(name)
        ? KimiLogoIcon
        : /qwen/.test(name)
          ? QwenLogoIcon
          : null;
  const Icon =
    brand ??
    (/claude|anthropic/.test(name)
      ? ClaudeLogoIcon
      : /(?:^|[\s/._-])(?:gpt|o[134](?:[\s/._-]|$))|openai/.test(name)
        ? OpenAILogoIcon
        : /gemini|gemma|google/.test(name)
          ? GeminiLogoIcon
          : /llama|meta/.test(name)
            ? MetaLogoIcon
            : /databricks/.test(provider)
              ? DatabricksLogoIcon
              : /anthropic/.test(provider)
                ? ClaudeLogoIcon
                : /openai/.test(provider)
                  ? OpenAILogoIcon
                  : /google/.test(provider)
                    ? GeminiLogoIcon
                    : RobotIcon);
  return <Icon size={18} aria-hidden="true" />;
}
