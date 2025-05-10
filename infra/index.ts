import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Get configuration
const config = new pulumi.Config();
const ecrRepoUrl = config.require("ECR_REPO_URL");
const s3Bucket = config.require("S3_BUCKET");

// Create a new VPC
const vpc = new awsx.ec2.Vpc("prxy-vpc", {
  cidrBlock: "10.0.0.0/16",
  numberOfAvailabilityZones: 1,
  natGateways: {
    strategy: "None",
  },
});

// Create a security group for the EC2 instance
const securityGroup = new aws.ec2.SecurityGroup("prxy-sg", {
  vpcId: vpc.vpcId,
  description: "Security group for PRXY server",
  ingress: [
    // Allow SSH access
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["0.0.0.0/0"],
      description: "SSH access",
    },
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

// Create an instance profile
const instanceProfile = new aws.iam.InstanceProfile("prxy-instance-profile", {
  role: ec2Role.name,
});

// User data script to install Docker and run the container
const userData = pulumi.interpolate`#!/bin/bash
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
docker pull ${ecrRepoUrl}:latest
docker run -d -p 3000:3000 --env-file /home/ubuntu/prxy/prxy.env --name prxy ${ecrRepoUrl}:latest

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
    Project: "PRXY",
  },
});

// Export the public IP of the instance
export const publicIp = instance.publicIp;
