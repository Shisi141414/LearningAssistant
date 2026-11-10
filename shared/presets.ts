/**
 * shared/presets.ts —— 供应商预设（出厂模板，数据不是代码 ADR-3 的例外说明：
 * 预设是"一键填充表单的模板"，不直接入库；入库后用户可随意改删）
 *
 * 模型能力来自 2026-11 调研（docs/01-research.md §2.3），会过时——
 * 设置页始终引导用户通过"导入模型"拉取真实列表，预设仅保证开箱能跑。
 */
import type { ProviderPreset } from './types'

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek 官方',
    base_url: 'https://api.deepseek.com/v1',
    api_format: 'openai',
    hint: '国内直连，性价比高',
    models: [
      { model_id: 'deepseek-chat', display_name: 'DeepSeek Chat', context_length: 128000, speed_tier: 'fast', notes: '通用对话，性价比首选' },
      { model_id: 'deepseek-reasoner', display_name: 'DeepSeek Reasoner', context_length: 128000, speed_tier: 'slow', notes: '深度推理（数学/证明强）' }
    ]
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_format: 'openai',
    hint: '国内直连，支持识图',
    models: [
      { model_id: 'glm-4.6', display_name: 'GLM-4.6', context_length: 128000, supports_vision: false, speed_tier: 'medium', notes: '长上下文衰减约 35-40K，识图用 GLM-4V 系' }
    ]
  },
  {
    key: 'dashscope',
    label: '通义千问 DashScope',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_format: 'openai',
    hint: '阿里云，国内直连',
    models: [
      { model_id: 'qwen-plus', display_name: 'Qwen Plus', context_length: 131072, speed_tier: 'fast', notes: '均衡型' },
      { model_id: 'qwen-max', display_name: 'Qwen Max', context_length: 131072, speed_tier: 'medium', notes: '旗舰，效果最好' },
      { model_id: 'qwen-vl-plus', display_name: 'Qwen VL Plus', context_length: 32768, supports_vision: true, speed_tier: 'fast', notes: '识图模型（板书/图片识别）' }
    ]
  },
  {
    key: 'moonshot',
    label: 'Kimi (Moonshot)',
    base_url: 'https://api.moonshot.cn/v1',
    api_format: 'openai',
    hint: '国内直连，超长上下文',
    models: [
      { model_id: 'kimi-k2-0905-preview', display_name: 'Kimi K2', context_length: 256000, speed_tier: 'medium', notes: '256K 长上下文' }
    ]
  },
  {
    key: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    base_url: 'https://api.siliconflow.cn/v1',
    api_format: 'openai',
    hint: '聚合平台，一站多模型',
    models: [
      { model_id: 'deepseek-ai/DeepSeek-V3', display_name: 'DeepSeek V3 (SF)', context_length: 65536, speed_tier: 'fast', notes: '聚合托管版' }
    ]
  },
  {
    key: 'openai',
    label: 'OpenAI 官方',
    base_url: 'https://api.openai.com/v1',
    api_format: 'openai',
    hint: '需国际网络或中转',
    models: [
      { model_id: 'gpt-4o', display_name: 'GPT-4o', context_length: 128000, supports_vision: true, speed_tier: 'fast', notes: '多模态旗舰' },
      { model_id: 'gpt-4o-mini', display_name: 'GPT-4o mini', context_length: 128000, supports_vision: true, speed_tier: 'fast', notes: '轻量便宜' }
    ]
  },
  {
    key: 'anthropic',
    label: 'Anthropic Claude',
    base_url: 'https://api.anthropic.com',
    api_format: 'anthropic',
    hint: '需国际网络或中转；上游格式选 anthropic',
    models: [
      { model_id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', context_length: 200000, supports_vision: true, speed_tier: 'medium', notes: '均衡旗舰' }
    ]
  }
]
