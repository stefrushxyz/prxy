import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Get configuration
const config = new pulumi.Config();
const projectName = config.get("PROJECT_NAME") || "prxy";
const ec2InstanceType = config.get("EC2_INSTANCE_TYPE") || "t3.micro";
const updateInterval = config.get("UPDATE_INTERVAL") || "10";
const port = config.get("PORT") || "3000";
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
      fromPort: Number.parseInt(port),
      toPort: Number.parseInt(port),
      cidrBlocks: ["0.0.0.0/0"],
      description: "PRXY server access",
    },
    // Allow HTTPS access from anywhere
    {
      protocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ["0.0.0.0/0"],
      description: "HTTPS access",
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
sudo apt-get install -y docker.io awscli nginx certbot python3-certbot-nginx

# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Create directory for application files
mkdir -p /home/ubuntu/prxy
touch /home/ubuntu/prxy/update.log
chown -R ubuntu:ubuntu /home/ubuntu/prxy
chmod 755 /home/ubuntu/prxy
chmod 644 /home/ubuntu/prxy/update.log

# Configure Nginx as a reverse proxy with SSL
cat > /etc/nginx/sites-available/prxy << 'EOL'
server {
    listen 80;
    server_name _;

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name _;

    # SSL configuration will be added by Certbot

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOL

# Enable the Nginx site
ln -s /etc/nginx/sites-available/prxy /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Setup auto-renewal script for SSL certificates
cat > /home/ubuntu/prxy/renew-ssl.sh << 'EOL'
#!/bin/bash
# This script will be run by cron to renew SSL certificates

# Get the public IP
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)

# Check if domain is configured, if not, use IP address
if [ -f /home/ubuntu/prxy/domain.txt ]; then
  DOMAIN=$(cat /home/ubuntu/prxy/domain.txt)
else
  DOMAIN=$PUBLIC_IP
fi

# Attempt to renew the certificate
certbot renew --nginx --non-interactive
EOL

chmod +x /home/ubuntu/prxy/renew-ssl.sh

# Add a cron job to run the renewal script twice a day
(crontab -l 2>/dev/null; echo "0 0,12 * * * /home/ubuntu/prxy/renew-ssl.sh") | crontab -

# Create a script to set up initial SSL certificate
cat > /home/ubuntu/prxy/setup-ssl.sh << 'EOL'
#!/bin/bash
# Get the public IP
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)

# Check if domain file exists
if [ -f /home/ubuntu/prxy/domain.txt ]; then
  DOMAIN=$(cat /home/ubuntu/prxy/domain.txt)
  echo "Using domain: $DOMAIN"
  
  # Get a certificate using the domain
  certbot --nginx --non-interactive --agree-tos --email admin@$DOMAIN -d $DOMAIN
else
  echo "No domain configured, using self-signed certificate for IP: $PUBLIC_IP"
  
  # Create self-signed certificate for the IP address
  mkdir -p /etc/ssl/prxy
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/prxy/prxy.key \
    -out /etc/ssl/prxy/prxy.crt \
    -subj "/CN=$PUBLIC_IP" \
    -addext "subjectAltName = IP:$PUBLIC_IP"
  
  # Configure Nginx to use the self-signed certificate
  sed -i "s/# SSL configuration will be added by Certbot/ssl_certificate \/etc\/ssl\/prxy\/prxy.crt;\n    ssl_certificate_key \/etc\/ssl\/prxy\/prxy.key;/" /etc/nginx/sites-available/prxy
fi

# Restart Nginx to apply changes
systemctl restart nginx
EOL

chmod +x /home/ubuntu/prxy/setup-ssl.sh

// Create update script
cat > /home/ubuntu/prxy/update.sh << 'EOL'
#!/bin/bash
S3_BUCKET=$1
INTERVAL=$2
LOG_FILE="/home/ubuntu/prxy/update.log"

# Ensure proper permissions
if [ ! -f "$LOG_FILE" ]; then
  touch "$LOG_FILE"
  chmod 644 "$LOG_FILE"
fi

echo "Starting update checker with interval $INTERVAL seconds" >> $LOG_FILE

# Create empty prxy.env file if it doesn't exist
if [ ! -f "/home/ubuntu/prxy/prxy.env" ]; then
  touch /home/ubuntu/prxy/prxy.env
  chmod 644 /home/ubuntu/prxy/prxy.env
fi

# Check for a domain config file in S3 and download it if it exists
if aws s3 ls s3://$S3_BUCKET/domain.txt &>/dev/null; then
  echo "Found domain configuration file, downloading" >> $LOG_FILE
  aws s3 cp s3://$S3_BUCKET/domain.txt /home/ubuntu/prxy/domain.txt
  chmod 644 /home/ubuntu/prxy/domain.txt
  # Run the SSL setup script to reconfigure with the domain if needed
  /home/ubuntu/prxy/setup-ssl.sh
fi

while true; do
  echo "Checking for updates at $(date)" >> $LOG_FILE

  # Check if the update trigger file exists in S3
  if aws s3 ls s3://$S3_BUCKET/update-trigger.txt &>/dev/null; then
    echo "Found update trigger" >> $LOG_FILE
    
    # Get the content of the trigger file (should be ECR_REPO_URL:IMAGE_TAG)
    aws s3 cp s3://$S3_BUCKET/update-trigger.txt /home/ubuntu/prxy/update-trigger.txt
    chmod 644 /home/ubuntu/prxy/update-trigger.txt
    
    if [ -f "/home/ubuntu/prxy/update-trigger.txt" ]; then
      TRIGGER_CONTENT=$(cat /home/ubuntu/prxy/update-trigger.txt)
      
      # Parse the content
      ECR_REPO_URL=$(echo $TRIGGER_CONTENT | cut -d':' -f1)
      IMAGE_TAG=$(echo $TRIGGER_CONTENT | cut -d':' -f2)
      
      echo "Updating to $ECR_REPO_URL:$IMAGE_TAG" >> $LOG_FILE
      
      # Get the environment file from S3
      aws s3 cp s3://$S3_BUCKET/prxy.env /home/ubuntu/prxy/prxy.env || touch /home/ubuntu/prxy/prxy.env
      chmod 644 /home/ubuntu/prxy/prxy.env
      
      # Check again for a domain config file in S3 and download it if it exists
      if aws s3 ls s3://$S3_BUCKET/domain.txt &>/dev/null; then
        echo "Found domain configuration file, downloading" >> $LOG_FILE
        aws s3 cp s3://$S3_BUCKET/domain.txt /home/ubuntu/prxy/domain.txt
        chmod 644 /home/ubuntu/prxy/domain.txt
      fi
      
      # Get the ECR login token
      aws ecr get-login-password --region $(curl -s http://169.254.169.254/latest/meta-data/placement/region) | \
        docker login --username AWS --password-stdin $ECR_REPO_URL
      
      # Pull and run the container
      if [ -n "$ECR_REPO_URL" ] && [ -n "$IMAGE_TAG" ]; then
        docker pull $ECR_REPO_URL:$IMAGE_TAG
        docker rm -f prxy 2>/dev/null || true
        docker run -d -p ${port}:${port} --env-file /home/ubuntu/prxy/prxy.env --name prxy $ECR_REPO_URL:$IMAGE_TAG
        
        # Remove the update trigger file from S3 after successful update
        aws s3 rm s3://$S3_BUCKET/update-trigger.txt
        echo "Update completed at $(date)" >> $LOG_FILE
      else
        echo "Invalid ECR_REPO_URL or IMAGE_TAG in trigger file" >> $LOG_FILE
      fi
    else
      echo "Failed to download update-trigger.txt" >> $LOG_FILE
    fi
  else
    echo "No update trigger found" >> $LOG_FILE
  fi
  
  sleep $INTERVAL
done
EOL

// Make the update script executable
chmod +x /home/ubuntu/prxy/update.sh

// Create a systemd service for the updater
cat > /etc/systemd/system/prxy-updater.service << EOL
[Unit]
Description=PRXY Updater
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/prxy
ExecStartPre=/bin/mkdir -p /home/ubuntu/prxy
ExecStartPre=/bin/chown -R ubuntu:ubuntu /home/ubuntu/prxy
ExecStartPre=/bin/chmod 755 /home/ubuntu/prxy
ExecStart=/home/ubuntu/prxy/update.sh ${s3Bucket} ${updateInterval}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOL

// Enable and start the updater service
systemctl enable prxy-updater.service
systemctl start prxy-updater.service

// Setup a service to restart the container on reboot
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

// Enable the PRXY service to start on boot
sudo systemctl enable prxy.service

// Run the SSL setup script
/home/ubuntu/prxy/setup-ssl.sh

// Start Nginx
systemctl enable nginx
systemctl restart nginx

// Configure aliases
cat >> /home/ubuntu/.bashrc << 'EOL'

# Custom aliases
alias l='ls -l'
alias ll='l -a'
alias v=vim
alias sv='sudo vim'
alias d='sudo docker'
alias sys='sudo systemctl'
alias jou='sudo journalctl'
EOL
`;

// Create an EC2 instance
const instance = new aws.ec2.Instance(
  `${projectName}-ec2-instance`,
  {
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
  },
  {
    replaceOnChanges: ["userData"],
  }
);

// Create an Elastic IP for the instance
const elasticIp = new aws.ec2.Eip(`${projectName}-eip`, {
  instance: instance.id,
  domain: "vpc",
  tags: {
    Name: `${projectName}-eip`,
    Project: projectName,
  },
});

// Export deployment details
export const publicIp = elasticIp.publicIp;
export const httpEndpoint = pulumi.interpolate`http://${elasticIp.publicIp}:${port}`;
export const httpsEndpoint = pulumi.interpolate`https://${elasticIp.publicIp}`;
export const deployedImageTag = imageTag;
export const deployedAt = deploymentTimestamp.toString();
