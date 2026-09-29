# -*- coding: utf-8 -*-
import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import ResNet18_Weights, resnet18


class PyramidPoolingBlock(nn.Module):
    def __init__(self, in_ch: int, bin_sizes=(1, 2, 3, 6)):
        super().__init__()
        self.bin_sizes = bin_sizes
        self.proj_convs = nn.ModuleList(
            [nn.Conv2d(in_ch, 512, kernel_size=1) for _ in bin_sizes]
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h, w = x.shape[2], x.shape[3]
        pooled_outputs = [x]
        for conv, bin_size in zip(self.proj_convs, self.bin_sizes):
            kernel_size = (h // bin_size, w // bin_size)
            stride = kernel_size
            pooled = F.avg_pool2d(x, kernel_size=kernel_size, stride=stride)
            pooled = F.relu(conv(pooled), inplace=True)
            upsampled = F.interpolate(pooled, size=(h, w), mode='bilinear', align_corners=False)
            pooled_outputs.append(upsampled)

        return torch.cat(pooled_outputs, dim=1)


def _adapt_resnet_input_conv(resnet: nn.Module, in_channels: int) -> None:
    old_conv = resnet.conv1
    new_conv = nn.Conv2d(
        in_channels,
        old_conv.out_channels,
        kernel_size=old_conv.kernel_size,
        stride=old_conv.stride,
        padding=old_conv.padding,
        bias=False,
    )
    with torch.no_grad():
        if old_conv.weight.shape[1] == in_channels:
            new_conv.weight.copy_(old_conv.weight)
        elif in_channels == 2 and old_conv.weight.shape[1] == 3:
            new_conv.weight.copy_(old_conv.weight[:, :2])
        else:
            nn.init.kaiming_normal_(new_conv.weight, mode='fan_out', nonlinearity='relu')
    resnet.conv1 = new_conv


class ResNetEncoder(nn.Module):
    """ResNet18 前 4 次下采样对应的全部模块，输出 stride 1/16、256 通道。

    4 次空间下采样：
      1. conv1 (stride=2)
      2. maxpool (stride=2)
      3. layer2 首个 block (stride=2)
      4. layer3 首个 block (stride=2)

    包含 conv1/bn1/relu/maxpool + layer1 + layer2 + layer3（不含 layer4）。
    """

    def __init__(self, in_channels: int = 2, pretrained: bool = False):
        super().__init__()
        weights = ResNet18_Weights.IMAGENET1K_V1 if pretrained else None
        backbone = resnet18(weights=weights)
        if in_channels != 3 or not pretrained:
            _adapt_resnet_input_conv(backbone, in_channels)

        self.conv1 = backbone.conv1
        self.bn1 = backbone.bn1
        self.relu = backbone.relu
        self.maxpool = backbone.maxpool
        self.layer1 = backbone.layer1
        self.layer2 = backbone.layer2
        self.layer3 = backbone.layer3

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv1(x)
        x = self.bn1(x)
        x = self.relu(x)
        x = self.maxpool(x)
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        return x


def _decode_head(x: torch.Tensor, convs: nn.ModuleList) -> torch.Tensor:
    """4 次 2x 上采样，与 1/16 backbone 输出对齐到原图尺度。"""
    for conv in convs:
        x = F.relu(conv(x), inplace=True)
        x = F.interpolate(x, scale_factor=2, mode='bilinear', align_corners=False)
    return x


class MultiTaskPSPNet(nn.Module):
    def __init__(self, in_channels: int = 2, num_classes: int = 2, bin_sizes=(1, 2, 3, 6),
                 pretrained_backbone: bool = False, num_force_outputs: int = 3):
        super().__init__()

        self.encoder = ResNetEncoder(in_channels=in_channels, pretrained=pretrained_backbone)
        backbone_out_channels = 256

        self.ppm = PyramidPoolingBlock(backbone_out_channels, bin_sizes=bin_sizes)
        psp_out_channels = backbone_out_channels + len(bin_sizes) * 512

        self.seg_convs = nn.ModuleList([
            nn.Conv2d(psp_out_channels, 256, kernel_size=3, padding=1),
            nn.Conv2d(256, 128, kernel_size=3, padding=1),
            nn.Conv2d(128, 64, kernel_size=3, padding=1),
            nn.Conv2d(64, 32, kernel_size=3, padding=1),
        ])
        self.seg_head = nn.Conv2d(32, num_classes, kernel_size=1)

        self.reg_convs = nn.ModuleList([
            nn.Conv2d(psp_out_channels, 256, kernel_size=3, padding=1),
            nn.Conv2d(256, 128, kernel_size=3, padding=1),
            nn.Conv2d(128, 64, kernel_size=3, padding=1),
            nn.Conv2d(64, 32, kernel_size=3, padding=1),
        ])
        self.force_pool = nn.AdaptiveAvgPool2d(1)
        self.num_force_outputs = int(num_force_outputs)
        self.force_head = nn.Linear(32, self.num_force_outputs)

    def forward(self, x: torch.Tensor):
        input_size = x.shape[2:]

        x = self.encoder(x)
        x = self.ppm(x)

        seg = _decode_head(x, self.seg_convs)
        pred_segmentation = torch.sigmoid(self.seg_head(seg))

        reg = _decode_head(x, self.reg_convs)
        pred_force = self.force_head(self.force_pool(reg).flatten(1))

        if pred_segmentation.shape[2:] != input_size:
            pred_segmentation = F.interpolate(
                pred_segmentation, size=input_size, mode='bilinear', align_corners=False)

        return pred_segmentation, pred_force
