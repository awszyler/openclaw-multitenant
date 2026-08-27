/**
 * 全局配置接口
 */
export interface OpenClawConfig {
  readonly stage: string;
  readonly region?: string;
  /** ARN 分区: aws | aws-cn */
  readonly partition?: string;
  readonly vpcId?: string;
  readonly privateSubnetIds?: string[];
  readonly ecsClusterName?: string;
  readonly litellmEndpoint?: string;
  readonly internalApps?: Record<string, { endpoint: string; port: number }>;
  readonly dataBucketName?: string;
  readonly skillGroups: string[];
  readonly ecrRepoPrefix?: string;
  readonly enableWaf?: boolean;
  readonly dynamoDbBillingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /** 部署模式: global（使用 Cognito）| china（使用自建 Auth Service） */
  readonly deploymentMode?: 'global' | 'china';
  /** 自定义域名（中国区必填） */
  readonly customDomain?: string;
  /** ICP 备案域名（中国区必填） */
  readonly icpDomain?: string;
  /** IAM 证书 ID（中国区必填） */
  readonly iamCertificateId?: string;
  /** 初始管理员邮箱 */
  readonly adminEmail?: string;
}

/** 中国区 region 列表 */
const CHINA_REGIONS = ['cn-north-1', 'cn-northwest-1'];

/** 根据 region 自动推断 ARN 分区 */
export function resolvePartition(region: string): 'aws' | 'aws-cn' {
  return CHINA_REGIONS.includes(region) ? 'aws-cn' : 'aws';
}

/** 根据 region 自动推断部署模式 */
export function resolveDeploymentMode(region: string): 'global' | 'china' {
  return CHINA_REGIONS.includes(region) ? 'china' : 'global';
}

/**
 * 将 region 缩写为适合 IAM role name 的短标识。
 * 例: ap-northeast-2 → apne2, cn-north-1 → cnn1, us-east-1 → use1
 */
export function regionShortName(region: string): string {
  const map: Record<string, string> = {
    'ap-northeast-1': 'apne1',
    'ap-northeast-2': 'apne2',
    'ap-northeast-3': 'apne3',
    'ap-southeast-1': 'apse1',
    'ap-southeast-2': 'apse2',
    'ap-south-1': 'aps1',
    'us-east-1': 'use1',
    'us-east-2': 'use2',
    'us-west-1': 'usw1',
    'us-west-2': 'usw2',
    'eu-west-1': 'euw1',
    'eu-central-1': 'euc1',
    'cn-north-1': 'cnn1',
    'cn-northwest-1': 'cnnw1',
  };
  return map[region] || region.replace(/-/g, '');
}

/**
 * 返回 ECR 域名后缀。中国区为 .amazonaws.com.cn，其他为 .amazonaws.com
 */
export function ecrDomain(account: string, region: string): string {
  const suffix = CHINA_REGIONS.includes(region) ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `${account}.dkr.ecr.${region}.${suffix}`;
}

export const DEFAULT_CONFIG: Partial<OpenClawConfig> = {
  region: 'ap-northeast-2',
  stage: 'dev',
  skillGroups: ['general'],
  enableWaf: true,
  dynamoDbBillingMode: 'PAY_PER_REQUEST',
  ecrRepoPrefix: 'openclaw',
};
