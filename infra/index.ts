import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Get configuration
const config = new pulumi.Config();
const projectName = config.get("PROJECT_NAME") || "prxy";
const ecrRepoUrl = config.require("ECR_REPO_URL");
const s3Bucket = config.require("S3_BUCKET");
const imageTag = config.get("IMAGE_TAG") || "latest";
const deploymentTimestamp = Date.now();

// Create a new VPC
const vpc = new awsx.ec2.Vpc("prxy-vpc", {
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
const securityGroup = new aws.ec2.SecurityGroup("prxy-sg", {
  vpcId: vpc.vpcId,
  description: "Security group for PRXY server",
  ingress: [
    // Allow HTTP access to the proxy server (port 3000)
    {
      protocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      cidrBlocks: ["0.0.0.0/0"],
      description: "PRXY server access",
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
const ec2Role = new aws.iam.Role("prxy-ec2-role", {
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
const ecrPolicy = new aws.iam.RolePolicy("prxy-ecr-inline-policy", {
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
const s3Policy = new aws.iam.RolePolicyAttachment("prxy-s3-policy", {
  role: ec2Role.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
});

// Attach policy for SSM access
const ssmPolicy = new aws.iam.RolePolicyAttachment("prxy-ssm-policy", {
  role: ec2Role.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

// Create an instance profile
const instanceProfile = new aws.iam.InstanceProfile("prxy-instance-profile", {
  role: ec2Role.name,
  tags: {
    Project: projectName,
  },
});

// User data script to install Docker and run the container
const userData = pulumi.interpolate`#!/bin/bash
# Deployment timestamp: ${deploymentTimestamp}

# Install Docker
sudo apt-get update
sudo apt-get install -y docker.io awscli
sudo systemctl start docker
sudo systemctl enable docker

# Create directory for application files
mkdir -p /home/ubuntu/prxy

# Get the environment file from S3
aws s3 cp s3://${s3Bucket}/prxy.env /home/ubuntu/prxy/prxy.env

# Get the ECR login token
aws ecr get-login-password --region $(curl -s http://169.254.169.254/latest/meta-data/placement/region) | \
  docker login --username AWS --password-stdin ${ecrRepoUrl}

# Pull and run the container
docker pull ${ecrRepoUrl}:${imageTag}
docker rm -f prxy 2>/dev/null || true
docker run -d -p 3000:3000 --env-file /home/ubuntu/prxy/prxy.env --name prxy ${ecrRepoUrl}:${imageTag}

# Create update script
cat > /home/ubuntu/prxy/update.sh << 'EOL'
#!/bin/bash
# Get parameters
S3_BUCKET=$1
ECR_REPO_URL=$2
IMAGE_TAG=$3

# Log update attempt
echo "Starting update at $(date)" >> /home/ubuntu/prxy/update.log

# Get the environment file from S3
aws s3 cp s3://$S3_BUCKET/prxy.env /home/ubuntu/prxy/prxy.env

# Get the ECR login token
aws ecr get-login-password --region $(curl -s http://169.254.169.254/latest/meta-data/placement/region) | \
  docker login --username AWS --password-stdin $ECR_REPO_URL

# Pull and run the container
docker pull $ECR_REPO_URL:$IMAGE_TAG
docker rm -f prxy 2>/dev/null || true
docker run -d -p 3000:3000 --env-file /home/ubuntu/prxy/prxy.env --name prxy $ECR_REPO_URL:$IMAGE_TAG

echo "Update completed at $(date)" >> /home/ubuntu/prxy/update.log
EOL

chmod +x /home/ubuntu/prxy/update.sh

# Create S3-triggered update script
cat > /home/ubuntu/prxy/check-update.sh << 'EOL'
#!/bin/bash
S3_BUCKET=$1

# Check if the update trigger file exists in S3
if aws s3 ls s3://$S3_BUCKET/update-trigger.txt &>/dev/null; then
  echo "Found update trigger at $(date)" >> /home/ubuntu/prxy/update.log
  
  # Get the content of the trigger file (should be ECR_REPO_URL:IMAGE_TAG)
  aws s3 cp s3://$S3_BUCKET/update-trigger.txt /home/ubuntu/prxy/update-trigger.txt
  TRIGGER_CONTENT=$(cat /home/ubuntu/prxy/update-trigger.txt)
  
  # Parse the content
  ECR_REPO_URL=$(echo $TRIGGER_CONTENT | cut -d':' -f1)
  IMAGE_TAG=$(echo $TRIGGER_CONTENT | cut -d':' -f2)
  
  # Run the update script with the new parameters
  /home/ubuntu/prxy/update.sh $S3_BUCKET $ECR_REPO_URL $IMAGE_TAG
  
  # Remove the trigger file to avoid repeated updates
  rm -f /home/ubuntu/prxy/update-trigger.txt
fi
EOL

chmod +x /home/ubuntu/prxy/check-update.sh

# Setup a cron job to check for updates every minute
echo "* * * * * /home/ubuntu/prxy/update.sh ${s3Bucket} ${ecrRepoUrl} ${imageTag}" | crontab -
echo "*/1 * * * * root /home/ubuntu/prxy/check-update.sh ${s3Bucket}" > /etc/cron.d/prxy-check-update
chmod 0644 /etc/cron.d/prxy-check-update

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

sudo systemctl enable prxy.service
`;

// Create an EC2 instance
const instance = new aws.ec2.Instance("prxy-ec2-instance", {
  ami: aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ["099720109477"], // Canonical (Ubuntu)
    filters: [
      {
        name: "name",
        values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"],
      },
      { name: "virtualization-type", values: ["hvm"] },
    ],
  }).id,
  instanceType: "t2.micro",
  subnetId: vpc.publicSubnetIds[0],
  vpcSecurityGroupIds: [securityGroup.id],
  iamInstanceProfile: instanceProfile.name,
  userData: userData,
  tags: {
    Name: "prxy",
    ImageTag: imageTag,
    DeployedAt: deploymentTimestamp.toString(),
    Project: projectName,
  },
});

// Export the public IP of the instance
export const publicIp = instance.publicIp;
export const endpoint = pulumi.interpolate`http://${instance.publicIp}:3000`;
export const deployedImageTag = imageTag;
export const deployedAt = deploymentTimestamp.toString();
