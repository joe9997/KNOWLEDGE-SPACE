#include <stdio.h>

int main(void)
{
    int a[5];
    int n, i;
    int sum = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        sum += a[i];
    }

    printf("总分 = %d\n", sum);
    printf("平均 = %.2f\n", (double)sum / n);

    return 0;
}
