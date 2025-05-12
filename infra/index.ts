import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Get configuration
const config = new pulumi.Config();
const projectName = config.get("PROJECT_NAME") || "prxy";
const ec2InstanceType = config.get("EC2_INSTANCE_TYPE") || "t3.micro";
const updateInterval = config.get("UPDATE_INTERVAL") || "*/1 * * * *";
const imageTag = config.get("IMAGE_TAG") || "latest";
const s3Bucket = `${projectName}-s3-env`;
const deploymentTimestamp = Date.now();

// Create a new VPC
const vpc = new awsx.ec2.Vpc(`${projectName}-vpc`, {
  cidrBlock: "10.0.0.0/16",
  numberOfAvailabilityZones: 1,
  natGateways: {
    strategy: "None",
  },
  tags: {
    Project: projectName,
  },
});

// Create a security group for the EC2 instance
const securityGroup = new aws.ec2.SecurityGroup(`${projectName}-sg`, {
  vpcId: vpc.vpcId,
  description: "Security group for PRXY server",
  ingress: [
    // Allow HTTP access from anywhere
    {
      protocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      cidrBlocks: ["0.0.0.0/0"],
      description: "PRXY server access",
    },
    // Allow SSH access from anywhere
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["0.0.0.0/0"],
      description: "SSH access from anywhere",
    },
  ],
  egress: [
    // Allow all outbound traffic
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
      description: "Allow all outbound traffic",
    },
  ],
  tags: {
    Project: projectName,
  },
});

// Create an IAM role for the EC2 instance
const ec2Role = new aws.iam.Role(`${projectName}-ec2-role`, {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ec2.amazonaws.com",
        },
      },
    ],
  }),
  tags: {
    Project: projectName,
  },
});

// Attach policies for ECR access
const ecrPolicy = new aws.iam.RolePolicy(`${projectName}-ecr-policy`, {
  role: ec2Role.id,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "ecr:*",
        Resource: "*",
      },
    ],
  }),
});

// Attach policies for S3 access
const s3Policy = new aws.iam.RolePolicy(`${projectName}-s3-policy`, {
  role: ec2Role.id,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:ListBucket", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${s3Bucket}`, `arn:aws:s3:::${s3Bucket}/*`],
      },
    ],
  }),
});

// Create an instance profile
const instanceProfile = new aws.iam.InstanceProfile(
  `${projectName}-instance-profile`,
  {
    role: ec2Role.name,
    tags: {
      Project: projectName,
    },
  }
);

// User data script to install Docker and run the container
const userData = pulumi.interpolate`#!/bin/bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y docker.io awscli

# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Create directory for application files
mkdir -p /home/ubuntu/prxy

# Create update script
cat > /home/ubuntu/prxy/update.sh << 'EOL'
#!/bin/bash
S3_BUCKET=$1
LOG_FILE="/home/ubuntu/prxy/update.log"

echo "Checking for updates at $(date)" >> $LOG_FILE

# Check if the update trigger file exists in S3
if aws s3 ls s3://$S3_BUCKET/update-trigger.txt &>/dev/null; then
  echo "Found update trigger" >> $LOG_FILE
  
  # Get the content of the trigger file (should be ECR_REPO_URL:IMAGE_TAG)
  aws s3 cp s3://$S3_BUCKET/update-trigger.txt /home/ubuntu/prxy/update-trigger.txt
  TRIGGER_CONTENT=$(cat /home/ubuntu/prxy/update-trigger.txt)
  
  # Parse the content
  ECR_REPO_URL=$(echo $TRIGGER_CONTENT | cut -d':' -f1)
  IMAGE_TAG=$(echo $TRIGGER_CONTENT | cut -d':' -f2)
  
  echo "Updating to $ECR_REPO_URL:$IMAGE_TAG" >> $LOG_FILE
  
  # Get the environment file from S3
  aws s3 cp s3://$S3_BUCKET/prxy.env /home/ubuntu/prxy/prxy.env
  
  # Get the ECR login token
  aws ecr get-login-password --region $(curl -s http://169.254.169.254/latest/meta-data/placement/region) | \
    docker login --username AWS --password-stdin $ECR_REPO_URL
  
  # Pull and run the container
  docker pull $ECR_REPO_URL:$IMAGE_TAG
  docker rm -f prxy 2>/dev/null || true
  docker run -d -p 3000:3000 --env-file /home/ubuntu/prxy/prxy.env --name prxy $ECR_REPO_URL:$IMAGE_TAG
  
  # Remove the update trigger file from S3 after successful update
  aws s3 rm s3://$S3_BUCKET/update-trigger.txt
  echo "Update trigger removed from S3" >> $LOG_FILE
  
  echo "Update completed at $(date)" >> $LOG_FILE
else
  echo "No update trigger found" >> $LOG_FILE
fi
EOL

# Make the update script executable
chmod +x /home/ubuntu/prxy/update.sh

# Setup cron job to run the update script at the configured interval
echo "${updateInterval} /home/ubuntu/prxy/update.sh ${s3Bucket}" | crontab -

# Setup a service to restart the container on reboot
cat > /etc/systemd/system/prxy.service << EOL
[Unit]
Description=PRXY Container
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/docker start prxy
ExecStop=/usr/bin/docker stop prxy

[Install]
WantedBy=multi-user.target
EOL

# Enable the service to start on boot
sudo systemctl enable prxy.service
`;

// Create an EC2 instance
const instance = new aws.ec2.Instance(`${projectName}-ec2-instance`, {
  ami: aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ["099720109477"], // Canonical (Ubuntu)
    filters: [
      {
        name: "name",
        values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"],
      },
      { name: "virtualization-type", values: ["hvm"] },
    ],
  }).id,
  instanceType: ec2InstanceType,
  subnetId: vpc.publicSubnetIds[0],
  vpcSecurityGroupIds: [securityGroup.id],
  iamInstanceProfile: instanceProfile.name,
  userData,
  tags: {
    Name: projectName,
    ImageTag: imageTag,
    DeployedAt: deploymentTimestamp.toString(),
    Project: projectName,
  },
});

// Create an Elastic IP for the instance
const elasticIp = new aws.ec2.Eip(`${projectName}-eip`, {
  instance: instance.id,
  domain: "vpc",
  tags: {
    Name: `${projectName}-eip`,
    Project: projectName,
  },
});

// Export the public IP of the instance
export const publicIp = elasticIp.publicIp;
export const endpoint = pulumi.interpolate`http://${elasticIp.publicIp}:3000`;
export const deployedImageTag = imageTag;
export const deployedAt = deploymentTimestamp.toString();
