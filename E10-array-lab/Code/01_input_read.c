#include <stdio.h>

int main(void)
{
    int a[20];
    int n, i;

    printf("请输入个数 n：");
    scanf("%d", &n);

    printf("请输入 %d 个分数：", n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    printf("读回来的 %d 个数：", n);
    for (i = 0; i < n; i++) {
        printf("%d ", a[i]);
    }
    printf("\n");

    return 0;
}
