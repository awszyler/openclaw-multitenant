import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import type { OpenClawConfig } from '../config';
import { regionShortName, ecrDomain } from '../config';

export interface ComputeStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly taskSecurityGroup: ec2.SecurityGroup;
  readonly dataBucketName: string;
  readonly internalAlbDns?: string;
}

export class ComputeStack extends cdk.Stack {
  public readonly ecsCluster: ecs.Cluster;
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { config, vpc, dataBucketName } = props;
    const isChina = (config.deploymentMode || 'global') === 'china';

    this.ecsCluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `openclaw-${config.stage}`,
      vpc,
      containerInsights: true,
    });

    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(this, 'Ns', {
      name: `openclaw-${config.stage}.local`,
      vpc,
    });

    const regionShort = regionShortName(config.region || 'ap-northeast-2');
    const taskRole = iam.Role.fromRoleName(this, 'TaskRole', `openclaw-base-${config.stage}-${regionShort}`);
    const execRole = iam.Role.fromRoleName(this, 'ExecRole', `openclaw-exec-${config.stage}-${regionShort}`);
    const proxyRole = iam.Role.fromRoleName(this, 'ProxyRole', `openclaw-proxy-${config.stage}-${regionShort}`);
    const scopedRoleArn = `arn:${config.partition || 'aws'}:iam::${this.account}:role/openclaw-scoped-${config.stage}-${regionShort}`;

    const mainEntrypoint = [
      'set -e',
      '# HOME is overridden via container env so $HOME/.openclaw lands on the',
      '# shared ECS volume. Same path the sidecar sees at /data/state, so all',
      '# OpenClaw writes flow straight to the volume the sidecar syncs to S3.',
      'H="$HOME/.openclaw"',
      'mkdir -p "$H"',
      "echo '[init] HOME='\"$HOME\"' state-dir='\"$H\"",
      "echo '[init] Waiting for sidecar S3 restore...'",
      '# Wait up to 5 minutes. If sidecar hasn\'t finished, we MUST NOT',
      '# continue — main and sidecar writing the same volume concurrently',
      '# causes half-restored extensions and launch failures ("plugin',
      '# manifest not found"). Exit 1 so ECS health check rebuilds the task',
      '# and the sidecar gets another full window to finish.',
      "for i in $(seq 1 300); do [ -f /shared/.ready ] && break; sleep 1; done",
      'if [ ! -f /shared/.ready ]; then',
      "  echo '[init] FATAL: sidecar did not signal .ready within 300s; exiting so ECS rebuilds'",
      '  exit 1',
      'fi',
      "echo '[init] State restored'",
      '# Migrate image-baked extensions (wecom, default skills, etc.) into the',
      '# shared state dir on first boot. `cp -rn` never overwrites, so data',
      '# already restored from S3 wins on subsequent boots.',
      'BAKED=/home/node/.openclaw',
      'if [ "$H" != "$BAKED" ] && [ -d "$BAKED" ] && [ "$(ls -A "$BAKED" 2>/dev/null)" ]; then',
      '  cp -rn "$BAKED"/. "$H"/ 2>/dev/null || true',
      "  echo '[init] Baked image content merged into state-dir'",
      'fi',
      'if [ -n "$OPENCLAW_CONFIG_B64" ]; then',
      '  echo "$OPENCLAW_CONFIG_B64" | base64 -d > "$H/openclaw.json"',
      "  echo '[init] Config written'",
      'fi',
      '# Patch wecom plugin: disable auto-setting reasoningLevel to "stream"',
      '# for models that do not support reasoning (e.g. Nova, Llama).',
      '# Only patch for non-Claude models — Claude users keep the wecom',
      '# plugin reasoning stream behavior.',
      'WS_MON="$H/extensions/wecom/wecom/ws-monitor.js"',
      'if [ -f "$WS_MON" ] && [ -f "$H/openclaw.json" ]; then',
      '  MODEL_ID=$(cat "$H/openclaw.json" | python3 -c "import sys,json; c=json.load(sys.stdin); ps=c.get(\'models\',{}).get(\'providers\',{}); bm=ps.get(\'amazon-bedrock\',{}).get(\'models\',[]); print(bm[0][\'id\'] if bm else \'\')" 2>/dev/null || true)',
      '  case "$MODEL_ID" in',
      '    *claude*) echo "[init] Claude model detected — keeping wecom reasoning stream" ;;',
      '    *) if [ -n "$MODEL_ID" ]; then',
      '         sed -i \'s/reasoningLevel = "stream"/reasoningLevel = null/g\' "$WS_MON"',
      "         echo '[init] Non-Claude model — patched wecom ws-monitor.js: disabled auto reasoning stream'",
      '       fi ;;',
      '  esac',
      'fi',
      '# Start local credential proxy (forwards to Internal ALB, injects user-id header)',
      'if [ -n "$INTERNAL_ALB_URL" ]; then',
      "  echo '[init] Starting credential proxy on 127.0.0.1:9090'",
      '  USER_ID=${OPENCLAW_USER_ID:-default}',
      '  node -e "',
      "    const http = require('http');",
      '    const rules = [',
      "      { prefix: '/llm', target: '${INTERNAL_ALB_URL}/llm' },",
      "      { prefix: '/app', target: '${INTERNAL_ALB_URL}/app' },",
      '    ];',
      '    http.createServer((req, res) => {',
      '      const rule = rules.find(r => req.url.startsWith(r.prefix));',
      "      if (!rule) { res.writeHead(403); res.end('Forbidden'); return; }",
      '      const target = rule.target + req.url.slice(rule.prefix.length);',
      '      const parsed = new URL(target);',
      "      const opts = { hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname + parsed.search, method: req.method, headers: { ...req.headers, host: parsed.host, 'x-openclaw-user-id': '${USER_ID}' } };",
      "      delete opts.headers['content-length'];",
      '      const proxy = http.request(opts, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });',
      '      req.pipe(proxy);',
      "      proxy.on('error', e => { res.writeHead(502); res.end(e.message); });",
      "    }).listen(9090, '127.0.0.1');",
      "    console.log('[proxy] Listening on 127.0.0.1:9090');",
      '  " &',
      '  sleep 1',
      'fi',
      "echo '[init] Starting gateway'",
      '# OPENCLAW_NO_RESPAWN=1 tells the gateway to do an in-process restart',
      '# on config reload instead of fork+exit. Without it the gateway exits 0',
      '# expecting a supervisor to rerun it — in our container that just kills',
      '# PID 1 and the task dies. (Documented in openclaw source:',
      '# restartGatewayProcessWithFreshPid → "caller should keep in-process',
      '# restart behavior".)',
      'export OPENCLAW_NO_RESPAWN=1',
      'exec node /app/dist/index.js gateway --port 3000 --bind lan',
    ].join('\n');

    const sidecarScript = [
      'set -e',
      'D=/data',
      'STATE_DIR="$D/state"',
      'chmod 777 $D',
      'USER_ID=${OPENCLAW_USER_ID:-default}',
      'BUCKET=${SESSION_BUCKET}',
      'PREFIX="${USER_ID}/state"',
      'assume_role() {',
      '  # Unset any previously-exported scoped credentials first, otherwise',
      '  # AWS CLI calls STS with the scoped-role identity and fails TagSession',
      '  # (scoped role\'s trust policy only allows base role to tag). Clearing',
      '  # here lets the container task-role creds (base role) be used.',
      '  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN',
      '  CREDS=$(aws sts assume-role --role-arn $SCOPED_ROLE_ARN --role-session-name sync-$USER_ID --duration-seconds 3600 --tags Key=userId,Value=$USER_ID --output json) || return 1',
      '  export AWS_ACCESS_KEY_ID=$(echo $CREDS | python3 -c "import sys,json;print(json.load(sys.stdin)[\'Credentials\'][\'AccessKeyId\'])")',
      '  export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | python3 -c "import sys,json;print(json.load(sys.stdin)[\'Credentials\'][\'SecretAccessKey\'])")',
      '  export AWS_SESSION_TOKEN=$(echo $CREDS | python3 -c "import sys,json;print(json.load(sys.stdin)[\'Credentials\'][\'SessionToken\'])")',
      '}',
      'sync_up() {',
      '  assume_role || { echo "[sync] assume_role failed, skipping upload"; return; }',
      '  # Source is STATE_DIR (same inode as main container $HOME/.openclaw).',
      '  # Excludes:',
      '  #   */node_modules/* — baked into the image, round-tripping adds 510MB',
      '  #     and 40k+ objects per user for no benefit.',
      '  #   *.sock/*.pid — runtime ephemeral.',
      '  #   .ready — sidecar-local handshake flag, not state.',
      '  if ! aws s3 sync "$STATE_DIR/" "s3://$BUCKET/$PREFIX/" --exclude "*/node_modules/*" --exclude "*.sock" --exclude "*.pid" --exclude ".ready" --size-only --only-show-errors 2>&1; then',
      '    echo "[sync] upload failed (above)"',
      '  fi',
      '}',
      'assume_role || echo "[sync] WARNING: initial assume_role failed; restore will return empty state"',
      "echo '[sync] Restoring from s3://'\"$BUCKET/$PREFIX/\"' to '\"$STATE_DIR\"'...'",
      'mkdir -p "$STATE_DIR"',
      '# Same exclusion list as upload — older deployments may have polluted',
      '# S3 with node_modules. Download what matters, ignore the noise.',
      'if aws s3 sync "s3://$BUCKET/$PREFIX/" "$STATE_DIR/" --exclude "*/node_modules/*" --only-show-errors 2>&1; then',
      "  echo '[sync] Restore complete'",
      'else',
      "  echo '[sync] Restore had errors (above); continuing with partial state'",
      'fi',
      '# UID 1000 = node in the openclaw image; match so main can write.',
      'chown -R 1000:1000 $D',
      'touch $D/.ready',
      '# Final sync on termination — ECS sends SIGTERM before killing the task,',
      '# so flush any unsynced data before exit.',
      'trap "echo \'[sync] SIGTERM received, final sync\'; sync_up; exit 0" TERM',
      'while true; do',
      '  sleep 30',
      '  sync_up',
      'done',
    ].join('\n');

    const taskDef = new ecs.FargateTaskDefinition(this, 'Td', {
      family: `openclaw-${config.stage}`,
      cpu: 2048,
      memoryLimitMiB: 4096,
      taskRole,
      executionRole: execRole,
      ephemeralStorageGiB: 30,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const sharedVolume: ecs.Volume = { name: 'shared' };
    taskDef.addVolume(sharedVolume);

    const mainLogGroup = new logs.LogGroup(this, 'MainLg', {
      logGroupName: `/openclaw/${config.stage}/main`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sidecarLogGroup = new logs.LogGroup(this, 'SidecarLg', {
      logGroupName: `/openclaw/${config.stage}/sidecar`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // China regions cannot reach public.ecr.aws; use private ECR sidecar image instead.
    const sidecarImage = isChina
      ? `${ecrDomain(this.account, this.region)}/${config.ecrRepoPrefix || 'openclaw'}-sidecar:latest`
      : 'public.ecr.aws/aws-cli/aws-cli:latest';

    // Container 2: cred-proxy sidecar (added first so main can depend on it)
    const sidecar = taskDef.addContainer('cred-proxy', {
      image: ecs.ContainerImage.fromRegistry(sidecarImage),
      entryPoint: ['sh', '-c'],
      command: [sidecarScript],
      essential: false,
      // Give the SIGTERM trap room to flush a final S3 sync before SIGKILL.
      // Fargate default is 30s; 60s is well within the 120s hard cap.
      stopTimeout: cdk.Duration.seconds(60),
      environment: {
        SESSION_BUCKET: dataBucketName,
        SCOPED_ROLE_ARN: scopedRoleArn,
        AWS_DEFAULT_REGION: config.region || 'ap-northeast-2',
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: sidecarLogGroup, streamPrefix: 'sync' }),
    });
    sidecar.addMountPoints({
      sourceVolume: 'shared',
      containerPath: '/data',
      readOnly: false,
    });

    // Container 1: openclaw main
    const main = taskDef.addContainer('openclaw', {
      image: ecs.ContainerImage.fromRegistry(
        `${ecrDomain(this.account, this.region)}/openclaw-general:latest`,
      ),
      entryPoint: ['sh', '-c'],
      command: [mainEntrypoint],
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        startPeriod: cdk.Duration.seconds(120),
        retries: 3,
      },
      environment: {
        OPENCLAW_STAGE: config.stage,
        AWS_EC2_METADATA_DISABLED: 'true',
        // Redirect OpenClaw's state dir ($HOME/.openclaw) onto the ECS shared
        // volume so the sidecar's /data/state is the same on-disk directory.
        // No background mirror process needed.
        HOME: '/shared/state',
        ...(props.internalAlbDns ? { INTERNAL_ALB_URL: `http://${props.internalAlbDns}:443` } : {}),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: mainLogGroup, streamPrefix: 'app' }),
    });
    main.addMountPoints({
      sourceVolume: 'shared',
      containerPath: '/shared',
      readOnly: false,
    });
    main.addContainerDependencies({
      container: sidecar,
      condition: ecs.ContainerDependencyCondition.START,
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: this.ecsCluster.clusterName });
    new cdk.CfnOutput(this, 'NamespaceId', { value: this.cloudMapNamespace.namespaceId });
    new cdk.CfnOutput(this, 'TaskDefArn', { value: taskDef.taskDefinitionArn });
  }
}
